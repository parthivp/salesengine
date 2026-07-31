import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant } from '../db'
import { detectAcceptance, recordAcceptance } from '../linkedin/acceptance'
import { importConnections, stripPreamble } from '../linkedin/connections'

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
const AT = new Date('2026-07-20T10:00:00Z')

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'accept-test' },
    update: {},
    create: { slug: 'accept-test', name: 'Acceptance Test Co' },
  })
  tenantId = t.id
})

beforeEach(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
})

afterAll(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

const seed = (linkedinUrl: string, over: Record<string, unknown> = {}) =>
  owner.contact.create({
    data: { tenantId, firstName: 'Borong', lastName: 'Liu', linkedinUrl, ...over },
  })

const NOTIFICATION = {
  fromEmail: 'invitations@linkedin.com',
  subject: 'Borong Liu accepted your invitation to connect',
  bodyText: 'View profile: https://www.linkedin.com/in/borong-liu-40028888?trk=eml-x',
  bodyHtml: null,
  headers: { 'x-linkedin-class': 'INVITE-ACCEPT' },
}

describe('detecting acceptance', () => {
  it('recognises the notification and pulls out the profile', () => {
    const r = detectAcceptance(NOTIFICATION)
    expect(r).not.toBeNull()
    expect(r!.profiles).toEqual(['linkedin.com/in/borong-liu-40028888'])
  })

  it('works from the header alone when the subject is not English', () => {
    // The whole reason for reading headers first. A German or Japanese account
    // gets a translated subject; the header is the same either way.
    const r = detectAcceptance({
      ...NOTIFICATION,
      subject: 'Borong Liu hat Ihre Einladung angenommen',
    })
    expect(r).not.toBeNull()
    expect(r!.profiles).toHaveLength(1)
  })

  it('works from the subject alone when headers were stripped', () => {
    const r = detectAcceptance({ ...NOTIFICATION, headers: {} })
    expect(r).not.toBeNull()
  })

  it('ignores LinkedIn mail that is not an acceptance', () => {
    for (const subject of [
      'You have 3 new messages',
      'Andrew Mayes shared a post',
      'Your job alert for Legal Counsel',
      'Borong Liu wants to connect', // an *incoming* invitation, not an acceptance
    ]) {
      expect(detectAcceptance({ ...NOTIFICATION, subject, headers: {} }), subject).toBeNull()
    }
  })

  it('ignores mail that merely mentions LinkedIn', () => {
    // A prospect writing "I accepted your invitation to connect on LinkedIn" must
    // stay a reply — misreading it would skip the classifier entirely and the
    // sequence would keep running.
    expect(
      detectAcceptance({
        ...NOTIFICATION,
        fromEmail: 'borong@zhonglun.com',
        subject: 'Re: quick question — accepted your invitation to connect',
      })
    ).toBeNull()
  })

  it('is not fooled by a lookalike sender domain', () => {
    for (const from of ['noreply@linkedin.com.attacker.io', 'x@notlinkedin.com', 'x@linkedin.co']) {
      expect(detectAcceptance({ ...NOTIFICATION, fromEmail: from }), from).toBeNull()
    }
  })

  it('accepts LinkedIn\'s sending subdomains', () => {
    for (const from of ['invitations@e.linkedin.com', 'no-reply@el.linkedin.com']) {
      expect(detectAcceptance({ ...NOTIFICATION, fromEmail: from }), from).not.toBeNull()
    }
  })
})

describe('recording acceptance', () => {
  it('marks the contact connected and brings the follow-up forward', async () => {
    const contact = await seed('https://www.linkedin.com/in/borong-liu-40028888')
    await owner.task.create({
      data: {
        tenantId, type: 'linkedin', status: 'open',
        title: 'Follow up if Borong accepted', contactId: contact.id,
        dueAt: new Date('2026-08-30T00:00:00Z'), priority: 1,
      },
    })

    const r = await withTenant(tenantId, () =>
      recordAcceptance(['linkedin.com/in/borong-liu-40028888'], AT)
    )
    expect(r).toMatchObject({ matched: 1, alreadyKnown: 0 })

    const after = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    expect(after.linkedinConnectedAt?.toISOString()).toBe(AT.toISOString())
    expect(after.status).toBe('engaged')

    const task = await owner.task.findFirstOrThrow({ where: { contactId: contact.id } })
    expect(task.dueAt?.toISOString()).toBe(AT.toISOString())
    expect(task.title).toContain('they accepted')

    const activity = await owner.activity.findFirstOrThrow({ where: { contactId: contact.id } })
    expect(activity.summary).toContain('Accepted')
  })

  it('is idempotent — the same notification twice does not re-date the connection', async () => {
    const contact = await seed('https://www.linkedin.com/in/borong-liu-40028888')
    await withTenant(tenantId, () => recordAcceptance(['linkedin.com/in/borong-liu-40028888'], AT))
    const later = new Date(AT.getTime() + 86_400_000)
    const r = await withTenant(tenantId, () =>
      recordAcceptance(['linkedin.com/in/borong-liu-40028888'], later)
    )
    expect(r).toMatchObject({ matched: 0, alreadyKnown: 1 })

    const after = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    expect(after.linkedinConnectedAt?.toISOString()).toBe(AT.toISOString())
  })

  it('reports someone who accepted but is not in the CRM', async () => {
    const r = await withTenant(tenantId, () => recordAcceptance(['linkedin.com/in/stranger'], AT))
    expect(r).toMatchObject({ matched: 0, unmatched: ['linkedin.com/in/stranger'] })
  })
})

describe('the Connections export', () => {
  // LinkedIn puts three lines of preamble above the real header row.
  const CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Borong,Liu,https://www.linkedin.com/in/borong-liu-40028888,,Zhong Lun,Partner,05 Jul 2026
Andrew,Mayes,https://www.linkedin.com/in/mayesandrew,,DepoStack,Founder,18 Jul 2026
Nobody,Known,https://www.linkedin.com/in/nobodyknown,,Elsewhere,Analyst,01 Jan 2026
NoUrl,Person,,,Somewhere,Manager,02 Feb 2026
`

  it('finds the real header row under the preamble', () => {
    expect(stripPreamble(CSV).split('\n')[0]).toMatch(/^First Name,/)
  })

  it('marks the ones we know and counts the rest', async () => {
    const borong = await seed('https://linkedin.com/in/borong-liu-40028888')
    await seed('https://linkedin.com/in/mayesandrew', { firstName: 'Andrew' })

    const r = await withTenant(tenantId, () => importConnections(CSV))
    expect(r).toMatchObject({ matched: 2, unmatched: 1, withoutProfile: 1, alreadyKnown: 0 })

    const after = await owner.contact.findUniqueOrThrow({ where: { id: borong.id } })
    expect(after.linkedinConnectedAt?.getUTCFullYear()).toBe(2026)
    expect(after.linkedinConnectedAt?.getUTCMonth()).toBe(6) // July
  })

  it('never clears a connection date for someone absent from the file', async () => {
    // The export says nothing about declined or pending invitations, so absence
    // is not evidence. Clearing on absence would silently undo real history.
    const gone = await seed('https://linkedin.com/in/notinthefile', {
      firstName: 'Ghost', linkedinConnectedAt: AT,
    })
    await withTenant(tenantId, () => importConnections(CSV))
    const after = await owner.contact.findUniqueOrThrow({ where: { id: gone.id } })
    expect(after.linkedinConnectedAt?.toISOString()).toBe(AT.toISOString())
  })

  it('survives an unparseable date rather than failing the file', async () => {
    const c = await seed('https://linkedin.com/in/borong-liu-40028888')
    const broken = `First Name,URL,Connected On\nBorong,https://linkedin.com/in/borong-liu-40028888,not a date\n`
    const r = await withTenant(tenantId, () => importConnections(broken))
    expect(r.matched).toBe(1)
    const after = await owner.contact.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.linkedinConnectedAt).not.toBeNull()
  })

  it('a dry run writes nothing', async () => {
    const c = await seed('https://linkedin.com/in/borong-liu-40028888')
    const r = await withTenant(tenantId, () => importConnections(CSV, { dryRun: true }))
    expect(r.matched).toBe(1)
    const after = await owner.contact.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.linkedinConnectedAt).toBeNull()
  })
})
