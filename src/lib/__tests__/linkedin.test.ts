import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant, db } from '../db'
import { LINKEDIN_POLICY, assessPacing, DAILY_CEILINGS, withinLimit, LIMITS } from '../linkedin/policy'
import { draftMessage, checkDraft, groundedHooks, tighten, type DraftContext } from '../linkedin/draft'
import { parseSalesNav, importSalesNav } from '../linkedin/import'
import { buildQueue, recordAction, enqueueContacts } from '../linkedin/queue'

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
let userId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'li-test' },
    update: {},
    create: { slug: 'li-test', name: 'LinkedIn Test Co' },
  })
  tenantId = t.id
  const u = await owner.user.upsert({
    where: { tenantId_email: { tenantId, email: 'rep@li.test' } },
    update: {},
    create: { tenantId, email: 'rep@li.test', name: 'Li Rep', role: 'rep', status: 'active' },
  })
  userId = u.id
})

beforeEach(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.contactListMember.deleteMany({ where: { list: { tenantId } } })
  await owner.contactList.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
})

afterAll(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

// ===========================================================================

describe('policy', () => {
  it('states in code that no automation or evasion is implemented', () => {
    // This is the product's position, asserted so it cannot drift silently.
    expect(LINKEDIN_POLICY.automationImplemented).toBe(false)
    expect(LINKEDIN_POLICY.evasionImplemented).toBe(false)
    expect(LINKEDIN_POLICY.sendMechanism).toBe('human-in-the-loop')
  })

  it('allows sending below the daily ceiling', () => {
    const v = assessPacing('connect', 5)
    expect(v.allowed).toBe(true)
    expect(v.remaining).toBe(DAILY_CEILINGS.connect - 5)
    expect(v.message).toBeUndefined()
  })

  it('warns as the ceiling approaches', () => {
    const v = assessPacing('connect', DAILY_CEILINGS.connect - 2)
    expect(v.allowed).toBe(true)
    expect(v.message).toContain('2 left')
  })

  it('stops at the ceiling, and explains why rather than just blocking', () => {
    const v = assessPacing('connect', DAILY_CEILINGS.connect)
    expect(v.allowed).toBe(false)
    expect(v.remaining).toBe(0)
    expect(v.message).toMatch(/acceptance rates fall/i)
  })

  it('never reports negative headroom when the rep has gone over', () => {
    expect(assessPacing('connect', 999).remaining).toBe(0)
  })

  it('enforces LinkedIn\'s own length limits', () => {
    expect(withinLimit('connect', 'a'.repeat(LIMITS.connectionNote))).toBe(true)
    expect(withinLimit('connect', 'a'.repeat(LIMITS.connectionNote + 1))).toBe(false)
    // A message to an existing connection has far more room.
    expect(withinLimit('message', 'a'.repeat(LIMITS.connectionNote + 1))).toBe(true)
  })
})

describe('drafting', () => {
  const base: DraftContext = {
    firstName: 'Priya',
    title: 'VP of Sales',
    company: 'Northwind Logistics',
    industry: 'Logistics',
    employeeCount: 420,
    city: 'Bengaluru',
    senderFirstName: 'Rohan',
  }

  it('only uses facts the record actually supports', () => {
    const hooks = groundedHooks({ firstName: 'Ada' })
    // No title, company, size or industry — so nothing to say.
    expect(hooks).toHaveLength(0)
  })

  it('ranks a reply above every other signal', () => {
    const hooks = groundedHooks({ ...base, repliedAlready: true, emailedAlready: true })
    expect(hooks[0].key).toBe('replied')
  })

  it('leads with the reply when there has been one', () => {
    const d = draftMessage({ ...base, repliedAlready: true })
    expect(d.usedHooks).toContain('replied')
    expect(d.text).toMatch(/thanks for coming back/i)
    expect(d.generic).toBe(false)
  })

  it('references the earlier email when one was sent', () => {
    const d = draftMessage({ ...base, emailedAlready: true })
    expect(d.usedHooks).toContain('emailed')
    expect(d.text).toMatch(/emailed you earlier/i)
  })

  it('uses the function hook when nothing warmer exists', () => {
    const d = draftMessage(base)
    expect(d.usedHooks).toContain('function')
    expect(d.text).toContain('Priya')
    expect(d.text).toContain('Rohan')
  })

  it('flags a generic draft rather than pretending it is personalised', () => {
    const d = draftMessage({ firstName: 'Ada', company: 'Acme' })
    expect(d.generic).toBe(true)
    const checks = checkDraft(d, { firstName: 'Ada', company: 'Acme' })
    expect(checks.some((c) => c.message.includes('generic'))).toBe(true)
  })

  it('always stays inside the connection-note limit', () => {
    const wordy: DraftContext = {
      ...base,
      industry: 'Supply Chain, Logistics, Freight Forwarding and Warehouse Automation Services',
      title: 'Senior Vice President of Global Revenue Operations and Commercial Excellence',
    }
    const d = draftMessage(wordy, 'connect')
    expect(d.text.length).toBeLessThanOrEqual(LIMITS.connectionNote)
    expect(d.withinLimit).toBe(true)
  })

  it('trims on a sentence boundary, never mid-word', () => {
    const text = 'First sentence here. Second sentence that runs on and on and on.'
    const cut = tighten(text, 30)
    expect(cut).toBe('First sentence here.')
    expect(cut.endsWith('.')).toBe(true)
  })

  it('falls back to a word boundary when there is no sentence break', () => {
    const cut = tighten('averylongwordone averylongwordtwo averylongwordthree', 20)
    expect(cut).toBe('averylongwordone')
    expect(cut).not.toContain('averylongwordt')
  })

  it('warns when there is no first name to greet', () => {
    const ctx = { ...base, firstName: null }
    const checks = checkDraft(draftMessage(ctx), ctx)
    expect(checks.some((c) => c.message.includes('bare'))).toBe(true)
  })

  it('rejects a draft carrying an unresolved merge tag', () => {
    const d = { ...draftMessage(base), text: 'Hi {{first_name}}, hello' }
    const checks = checkDraft(d, base)
    expect(checks.some((c) => c.severity === 'error' && /merge tag/i.test(c.message))).toBe(true)
  })

  it('flags filler that reads as templated', () => {
    const d = { ...draftMessage(base), text: 'Hi Priya, wanted to touch base and circle back on synergy.' }
    expect(checkDraft(d, base).some((c) => /templated/i.test(c.message))).toBe(true)
  })

  it('prefers the specific function hook over one that merely matches a word', () => {
    // "VP Revenue Operations" contains "revenue", which the sales pattern also
    // matches. A RevOps leader offered a pipeline-coverage opener is the near-miss
    // that reads as automated.
    const hooks = groundedHooks({ firstName: 'Rhea', title: 'VP Revenue Operations' })
    const fn = hooks.find((h) => h.key === 'function')
    expect(fn?.topic).toBe('the handoffs between systems')
  })

  it.each([
    ['Chief Operating Officer', 'scheduling across sites'],
    ['Director of Customer Success', 'renewals and expansion'],
    ['Head of Sales', 'pipeline coverage'],
    ['Sales Operations Manager', 'the handoffs between systems'],
    ['CFO', 'forecast accuracy'],
  ])('classifies %s by function', (title, topic) => {
    const fn = groundedHooks({ title }).find((h) => h.key === 'function')
    expect(fn?.topic).toBe(topic)
  })

  it('never strands the size qualifier between a subject and its verb', () => {
    // "a lot of my work with teams, usually at about your size is pipeline
    // coverage" — an interjected clause with no closing comma. The qualifier
    // belongs at the end of the clause, so it must never be followed by a verb.
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
      for (const employeeCount of [12, 300, 4000]) {
        const d = draftMessage({ ...base, employeeCount, seed })
        expect(d.text, seed).not.toMatch(/, usually [^,.]+ (is|are|comes down to)\b/)
      }
    }
  })

  it('spreads variants evenly rather than clustering on one frame', () => {
    // A hash that clusters would leave most of the queue on a single frame, which
    // is the duplicate problem the variants exist to solve.
    const seen = new Map<number, number>()
    for (let i = 0; i < 300; i++) {
      const d = draftMessage({ ...base, seed: `contact-${i}` })
      seen.set(d.variant, (seen.get(d.variant) ?? 0) + 1)
    }
    expect(seen.size).toBe(3)
    for (const n of seen.values()) expect(n).toBeGreaterThan(60)
  })

  it('composes a grammatical sentence in every frame it can produce', () => {
    // The bug this guards: the function hook was phrased for the "I emailed you
    // about ___" slot and reused in the "I work with teams on ___" slot, giving
    // "I work with teams on how the team is handling pipeline coverage".
    const titles = ['VP of Sales', 'RevOps Lead', 'COO', 'CFO', 'Head of Talent']
    for (const title of titles) {
      for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        for (const emailed of [false, true]) {
          const d = draftMessage({ ...base, title, seed, emailedAlready: emailed })
          const sentence = d.text.split('\n')[0]
          expect(sentence, `${title}/${seed}`).not.toMatch(/\bon how the\b/)
          expect(sentence).not.toMatch(/\bteams\b.*\bthe team\b/)
          expect(sentence).not.toMatch(/\s{2,}|\s+\./)
          expect(sentence.trim().endsWith('.')).toBe(true)
        }
      }
    }
  })

  it('varies the phrasing between two people with identical facts', () => {
    // Same title, same company, same size — the facts are identical, so a single
    // frame would produce byte-identical notes. Twenty of those in a day is the
    // most recognisable automation tell there is.
    const texts = new Set(
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map(
        (seed) => draftMessage({ ...base, firstName: 'Sam', seed }).text
      )
    )
    expect(texts.size).toBeGreaterThan(1)
  })

  it('picks the same variant every time for the same contact', () => {
    // The rep must not watch the wording change under them on reload.
    const a = draftMessage({ ...base, seed: 'contact-abc' })
    const b = draftMessage({ ...base, seed: 'contact-abc' })
    expect(b.text).toBe(a.text)
    expect(b.variant).toBe(a.variant)
  })

  it('blocks a card whose record has no profile URL', () => {
    const ctx = { ...base, hasProfileUrl: false }
    const checks = checkDraft(draftMessage(ctx), ctx)
    expect(checks.some((c) => c.severity === 'error' && /profile URL/i.test(c.message))).toBe(true)
  })
})

describe('Sales Navigator import', () => {
  const CSV = `First Name,Last Name,Title,Company,Profile URL,Geography
Priya,Raman,VP of Sales,Northwind Logistics,https://www.linkedin.com/in/priyaraman/,Bengaluru
Daniel,Okafor,Head of RevOps,Northwind Logistics,https://linkedin.com/in/danielokafor?utm=x,Bengaluru
Sofia,Marchetti,CRO,LumenPay,https://www.linkedin.com/in/sofiamarchetti,Milan
Broken,Row,Analyst,Nowhere,not-a-linkedin-url,Nowhere
Priya,Raman,VP of Sales,Northwind Logistics,https://linkedin.com/in/priyaraman,Bengaluru
`

  it('recognises Sales Navigator column names', () => {
    const p = parseSalesNav(CSV)
    expect(p.suggested.linkedinUrl).toBe('Profile URL')
    expect(p.suggested.firstName).toBe('First Name')
    expect(p.suggested.companyName).toBe('Company')
    expect(p.suggested.city).toBe('Geography')
  })

  it('imports rows that have no email at all', async () => {
    // The whole reason this path exists: Sales Navigator exports rarely carry
    // email, and the generic importer rejects a row without one.
    const p = parseSalesNav(CSV)
    const r = await withTenant(tenantId, () =>
      importSalesNav({ rows: p.rows, mapping: p.suggested }), )

    expect(r.created).toBe(3)
    // Counted per distinct person actually considered — the malformed URL and the
    // in-file duplicate exit before the email check, which is the useful reading:
    // "3 people came in with no email", not "4 rows lacked one".
    expect(r.withoutEmail).toBe(3)
    expect(r.skipped).toBe(1) // the unusable URL
    expect(r.duplicates).toBe(1) // Priya twice in the file

    const contacts = await owner.contact.findMany({ where: { tenantId } })
    expect(contacts).toHaveLength(3)
    expect(contacts.every((c) => c.email === null)).toBe(true)
    expect(contacts.every((c) => c.linkedinUrl?.includes('linkedin.com/in/'))).toBe(true)
  })

  it('normalises profile URLs so tracking parameters do not create duplicates', async () => {
    const p = parseSalesNav(CSV)
    await withTenant(tenantId, () => importSalesNav({ rows: p.rows, mapping: p.suggested }))

    // Re-import the same people with different URL shapes.
    const again = parseSalesNav(
      `Profile URL,First Name\nhttps://www.linkedin.com/in/PriyaRaman/?trk=abc,Priya\n`
    )
    const r = await withTenant(tenantId, () =>
      importSalesNav({ rows: again.rows, mapping: again.suggested })
    )
    expect(r.created).toBe(0)
    expect(r.duplicates).toBe(1)
    expect(await owner.contact.count({ where: { tenantId } })).toBe(3)
  })

  it('groups people by company name when the export has no domain', async () => {
    const p = parseSalesNav(CSV)
    await withTenant(tenantId, () => importSalesNav({ rows: p.rows, mapping: p.suggested }))

    const accounts = await owner.account.findMany({ where: { tenantId } })
    const northwind = accounts.filter((a) => a.name === 'Northwind Logistics')
    expect(northwind).toHaveLength(1)

    const atNorthwind = await owner.contact.count({
      where: { tenantId, accountId: northwind[0].id },
    })
    expect(atNorthwind).toBe(2)
  })

  it('dry run writes nothing', async () => {
    const p = parseSalesNav(CSV)
    const r = await withTenant(tenantId, () =>
      importSalesNav({ rows: p.rows, mapping: p.suggested, dryRun: true })
    )
    expect(r.created).toBe(3)
    expect(await owner.contact.count({ where: { tenantId } })).toBe(0)
  })

  it('links an existing contact by email rather than duplicating them', async () => {
    await owner.contact.create({
      data: { tenantId, email: 'sofia@lumenpay.com', firstName: 'Sofia' },
    })
    const p = parseSalesNav(
      `Profile URL,First Name,Last Name,Email\nhttps://linkedin.com/in/sofiamarchetti,Sofia,Marchetti,sofia@lumenpay.com\n`
    )
    const r = await withTenant(tenantId, () =>
      importSalesNav({ rows: p.rows, mapping: p.suggested })
    )
    expect(r.created).toBe(0)
    expect(r.updated).toBe(1)

    const sofia = await owner.contact.findFirstOrThrow({ where: { tenantId, email: 'sofia@lumenpay.com' } })
    expect(sofia.linkedinUrl).toContain('sofiamarchetti')
    expect(sofia.lastName).toBe('Marchetti')
  })
})

describe('the queue', () => {
  async function seedContact(over: Record<string, unknown> = {}) {
    return withTenant(tenantId, async () => {
      const account = await db().account.create({
        data: { tenantId, name: 'Queue Co', domain: `q${Date.now()}.test`, employeeCount: 300, industry: 'Logistics' },
      })
      return db().contact.create({
        data: {
          tenantId,
          firstName: 'Quinn',
          lastName: 'Tester',
          title: 'VP of Sales',
          linkedinUrl: 'https://linkedin.com/in/quinntester',
          accountId: account.id,
          ownerId: userId,
          score: 70,
          ...over,
        },
      })
    })
  }

  it('queues a contact with a profile URL and drafts a card', async () => {
    const contact = await seedContact()
    const r = await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: [contact.id], assigneeId: userId })
    )
    expect(r.queued).toBe(1)

    const { cards } = await withTenant(tenantId, () =>
      buildQueue({ userId, senderFirstName: 'Rohan' })
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].profileUrl).toContain('quinntester')
    expect(cards[0].draft.text).toContain('Quinn')
    expect(cards[0].draft.withinLimit).toBe(true)
    expect(cards[0].rationale.length).toBeGreaterThan(0)
  })

  it('will not queue a contact with no profile URL', async () => {
    const contact = await seedContact({ linkedinUrl: null })
    const r = await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: [contact.id], assigneeId: userId })
    )
    expect(r.queued).toBe(0)
    expect(r.skipped).toBe(1)
  })

  it('will not queue a do-not-contact person', async () => {
    const contact = await seedContact({ status: 'do_not_contact' })
    const r = await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: [contact.id], assigneeId: userId })
    )
    expect(r.queued).toBe(0)
  })

  it('never shows the same person twice in one queue', async () => {
    const contact = await seedContact()
    await withTenant(tenantId, () => enqueueContacts({ contactIds: [contact.id], assigneeId: userId }))
    const second = await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: [contact.id], assigneeId: userId })
    )
    expect(second.queued).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('warns when two cards carry an identical note', async () => {
    // Force the collision the variant seed normally avoids: same everything, and
    // the draft text overridden on the task so both cards read the same.
    const a = await seedContact({ firstName: 'Ida' })
    const b = await seedContact({ firstName: 'Ida' })
    await withTenant(tenantId, async () => {
      await enqueueContacts({ contactIds: [a.id, b.id], assigneeId: userId })
      await db().task.updateMany({
        where: { type: 'linkedin', status: 'open', contactId: { in: [a.id, b.id] } },
        data: { payload: { stepType: 'linkedin_connect', draft: 'Hi Ida — same note.' } },
      })
    })

    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    const dupes = cards.filter((c) => c.checks.some((k) => /identical to/i.test(k.message)))
    expect(dupes).toHaveLength(2)
    expect(dupes[0].checks.some((k) => k.message.includes('1 other card'))).toBe(true)
  })

  it('does not warn about drafts that only share a greeting', async () => {
    const a = await seedContact({ firstName: 'Jo', title: 'VP of Sales' })
    const b = await seedContact({ firstName: 'Jo', title: 'CFO' })
    await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: [a.id, b.id], assigneeId: userId })
    )
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    expect(cards.some((c) => c.checks.some((k) => /identical to/i.test(k.message)))).toBe(false)
  })

  it('orders the queue by score, so a capped allowance goes to the best fits', async () => {
    const low = await seedContact({ score: 10, firstName: 'Low' })
    const high = await seedContact({ score: 95, firstName: 'High' })
    await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: [low.id, high.id], assigneeId: userId })
    )
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    expect(cards[0].name).toContain('High')
  })

  it('only marks a card done when the rep says so', async () => {
    const contact = await seedContact()
    await withTenant(tenantId, () => enqueueContacts({ contactIds: [contact.id], assigneeId: userId }))
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))

    // Nothing is completed by building or viewing the queue — the app cannot see
    // LinkedIn, so it must not assume the send happened.
    const before = await owner.task.findUniqueOrThrow({ where: { id: cards[0].taskId } })
    expect(before.status).toBe('open')

    await withTenant(tenantId, () =>
      recordAction({ taskId: cards[0].taskId, actorId: userId, outcome: 'sent', finalText: 'Hi Quinn' })
    )
    const after = await owner.task.findUniqueOrThrow({ where: { id: cards[0].taskId } })
    expect(after.status).toBe('completed')
    expect(after.outcome).toBe('sent')
  })

  it('records the action as the rep\'s assertion, not a confirmed delivery', async () => {
    const contact = await seedContact()
    await withTenant(tenantId, () => enqueueContacts({ contactIds: [contact.id], assigneeId: userId }))
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    await withTenant(tenantId, () =>
      recordAction({ taskId: cards[0].taskId, actorId: userId, outcome: 'sent', finalText: 'Hi Quinn' })
    )

    const activity = await owner.activity.findFirstOrThrow({
      where: { tenantId, contactId: contact.id },
    })
    expect(activity.summary).toMatch(/sent by the rep/i)
    expect((activity.detail as { source?: string }).source).toBe('human-in-the-loop')
  })

  it('schedules the after-acceptance follow-up, the step teams forget', async () => {
    const contact = await seedContact()
    await withTenant(tenantId, () => enqueueContacts({ contactIds: [contact.id], assigneeId: userId }))
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    await withTenant(tenantId, () =>
      recordAction({ taskId: cards[0].taskId, actorId: userId, outcome: 'sent' })
    )

    const followUps = await owner.task.findMany({
      where: { tenantId, type: 'linkedin', status: 'open' },
    })
    expect(followUps).toHaveLength(1)
    expect((followUps[0].payload as { stepType?: string }).stepType).toBe('linkedin_message')
    expect(followUps[0].dueAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('treats "not a fit" as a stop signal across the whole system', async () => {
    const contact = await seedContact()
    const sequence = await owner.sequence.create({
      data: { tenantId, name: `li-seq-${Date.now()}`, status: 'active' },
    })
    await owner.sequenceEnrollment.create({
      data: { tenantId, sequenceId: sequence.id, contactId: contact.id, status: 'active', nextRunAt: new Date() },
    })

    await withTenant(tenantId, () => enqueueContacts({ contactIds: [contact.id], assigneeId: userId }))
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    await withTenant(tenantId, () =>
      recordAction({ taskId: cards[0].taskId, actorId: userId, outcome: 'not_a_fit' })
    )

    const enrollment = await owner.sequenceEnrollment.findFirstOrThrow({ where: { tenantId } })
    expect(enrollment.status).toBe('stopped_manual')
    const after = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    expect(after.status).toBe('unqualified')

    await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
    await owner.sequence.delete({ where: { id: sequence.id } })
  })

  it('treats "already connected" as relationship information, not a skip', async () => {
    const contact = await seedContact()
    await withTenant(tenantId, () => enqueueContacts({ contactIds: [contact.id], assigneeId: userId }))
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))
    await withTenant(tenantId, () =>
      recordAction({ taskId: cards[0].taskId, actorId: userId, outcome: 'already_connected' })
    )
    const after = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    expect(after.status).toBe('engaged')
  })

  it('reports pacing headroom that reflects what was done today', async () => {
    const contacts = await Promise.all(Array.from({ length: 3 }, (_, i) => seedContact({ firstName: `P${i}` })))
    await withTenant(tenantId, () =>
      enqueueContacts({ contactIds: contacts.map((c) => c.id), assigneeId: userId })
    )
    const { cards } = await withTenant(tenantId, () => buildQueue({ userId }))

    await withTenant(tenantId, () =>
      recordAction({ taskId: cards[0].taskId, actorId: userId, outcome: 'sent' })
    )

    const { pacing } = await withTenant(tenantId, () => buildQueue({ userId }))
    expect(pacing.connect.remaining).toBe(DAILY_CEILINGS.connect - 1)
  })
})
