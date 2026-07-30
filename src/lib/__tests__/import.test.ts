import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant, db, prismaAdmin } from '../db'
import { importContacts, parseCsv } from '../leads/import'
import { nameSimilarity, normalizeLinkedIn, findDuplicates, mergeContacts } from '../leads/dedupe'
import { computeScore, scoreBand } from '../leads/scoring'
import type { Contact, Account } from '@prisma/client'

/**
 * Integration tests against real Postgres. The import path is the one users hit
 * first with messy real-world data, so it is tested with messy real-world data.
 */

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'import-test' },
    update: {},
    create: { slug: 'import-test', name: 'Import Test Co' },
  })
  tenantId = t.id
  // Clean slate so counts are deterministic across runs.
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
})

afterAll(async () => {
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

const CSV = `First Name,Last Name,Email,Title,Company,Company Domain,Person Linkedin Url
Ada,Lovelace,ada@analytical.test,VP of Sales,Analytical Engines,analytical.test,https://linkedin.com/in/adalovelace
Grace,Hopper,grace@analytical.test,Chief Technology Officer,Analytical Engines,analytical.test,
Alan,Turing,alan@bombe.test,Head of Growth,Bombe Ltd,bombe.test,
,,not-an-email,Engineer,Broken Inc,broken.test,
Ada,Lovelace,ada@analytical.test,VP of Sales,Analytical Engines,analytical.test,
Katherine,Johnson,katherine@orbital.test,Junior Analyst,Orbital,orbital.test,
`

describe('parseCsv', () => {
  it('recognises Apollo and Sales Navigator column names automatically', () => {
    const parsed = parseCsv(CSV)
    expect(parsed.suggested.email).toBe('Email')
    expect(parsed.suggested.firstName).toBe('First Name')
    expect(parsed.suggested.companyDomain).toBe('Company Domain')
    expect(parsed.suggested.linkedinUrl).toBe('Person Linkedin Url')
  })

  it('drops blank lines but keeps every data row', () => {
    const parsed = parseCsv(CSV)
    expect(parsed.totalRows).toBe(6)
  })
})

describe('importContacts', () => {
  it('dry run writes nothing', async () => {
    const parsed = parseCsv(CSV)
    const result = await withTenant(tenantId, () =>
      importContacts({ rows: parsed.rows, mapping: parsed.suggested, dryRun: true })
    )

    expect(result.created).toBe(4)
    expect(result.skipped).toBe(1) // the malformed email
    expect(result.duplicates).toBe(1) // Ada appears twice in the file

    const count = await owner.contact.count({ where: { tenantId } })
    expect(count).toBe(0)
  })

  it('creates contacts and derives accounts from the domain', async () => {
    const parsed = parseCsv(CSV)
    const result = await withTenant(
      tenantId,
      () => importContacts({ rows: parsed.rows, mapping: parsed.suggested }),
      { timeout: 60_000 }
    )

    expect(result.created).toBe(4)
    // Four contacts, three distinct domains — Ada and Grace share analytical.test.
    expect(result.accountsCreated).toBe(3)

    const contacts = await owner.contact.findMany({ where: { tenantId } })
    expect(contacts).toHaveLength(4)

    const ada = contacts.find((c) => c.email === 'ada@analytical.test')
    expect(ada?.firstName).toBe('Ada')
    expect(ada?.title).toBe('VP of Sales')

    // Two people at the same domain must share one account, not create two.
    const accounts = await owner.account.findMany({ where: { tenantId } })
    const analytical = accounts.filter((a) => a.domain === 'analytical.test')
    expect(analytical).toHaveLength(1)

    const atAnalytical = contacts.filter((c) => c.accountId === analytical[0].id)
    expect(atAnalytical).toHaveLength(2)
  })

  it('reports row numbers that match the spreadsheet', async () => {
    const parsed = parseCsv(CSV)
    const result = await withTenant(tenantId, () =>
      importContacts({ rows: parsed.rows, mapping: parsed.suggested, dryRun: true })
    )
    const bad = result.errors.find((e) => e.email === 'not-an-email')
    expect(bad?.row).toBe(5) // header is row 1, so the 4th data row is row 5
  })

  it('re-importing fills blanks without overwriting curated values', async () => {
    await withTenant(tenantId, async () => {
      const ada = await db().contact.findFirstOrThrow({ where: { email: 'ada@analytical.test' } })
      await db().contact.update({
        where: { id: ada.id },
        data: { title: 'Chief Revenue Officer', phone: null },
      })
    })

    const parsed = parseCsv(
      `Email,Title,Phone\nada@analytical.test,VP of Sales,+1 555 0100\n`
    )
    const result = await withTenant(tenantId, () =>
      importContacts({ rows: parsed.rows, mapping: parsed.suggested })
    )

    expect(result.updated).toBe(1)
    expect(result.created).toBe(0)

    const ada = await owner.contact.findFirstOrThrow({
      where: { tenantId, email: 'ada@analytical.test' },
    })
    expect(ada.title).toBe('Chief Revenue Officer') // curated value survived
    expect(ada.phone).toBe('+1 555 0100') // blank was filled
  })

  it('skips rather than updates when asked', async () => {
    const parsed = parseCsv(`Email,Title\nalan@bombe.test,Something Else\n`)
    const result = await withTenant(tenantId, () =>
      importContacts({ rows: parsed.rows, mapping: parsed.suggested, onDuplicate: 'skip' })
    )
    expect(result.skipped).toBe(1)
    expect(result.updated).toBe(0)
  })
})

describe('dedupe', () => {
  it('scores identical names as 1 and unrelated names low', () => {
    expect(nameSimilarity('Ada Lovelace', 'ada lovelace')).toBe(1)
    expect(nameSimilarity('Ada Lovelace', 'Alan Turing')).toBeLessThan(0.4)
    expect(nameSimilarity('Kate Johnson', 'Katherine Johnson')).toBeGreaterThan(0.6)
  })

  it('normalises LinkedIn URLs to a comparable form', () => {
    expect(normalizeLinkedIn('https://www.linkedin.com/in/AdaLovelace/')).toBe('linkedin.com/in/adalovelace')
    expect(normalizeLinkedIn('https://linkedin.com/in/adalovelace?utm=x')).toBe('linkedin.com/in/adalovelace')
    expect(normalizeLinkedIn('https://example.com/profile')).toBeNull()
  })

  it('finds an exact match on email', async () => {
    const matches = await withTenant(tenantId, () =>
      findDuplicates({ email: 'grace@analytical.test' })
    )
    expect(matches[0]?.confidence).toBe('exact')
  })

  it('merges a duplicate into the survivor, filling only gaps', async () => {
    const { targetId, sourceId } = await withTenant(tenantId, async () => {
      const target = await db().contact.create({
        data: { tenantId, email: 'merge-target@orbital.test', firstName: 'Kath', title: 'Analyst' },
      })
      const source = await db().contact.create({
        data: {
          tenantId, email: 'merge-source@orbital.test', firstName: 'Katherine',
          lastName: 'Johnson', title: 'Senior Analyst', phone: '+1 555 0199',
        },
      })
      return { targetId: target.id, sourceId: source.id }
    })

    await withTenant(tenantId, () => mergeContacts(targetId, sourceId))

    const merged = await owner.contact.findUniqueOrThrow({ where: { id: targetId } })
    expect(merged.firstName).toBe('Kath') // target wins
    expect(merged.lastName).toBe('Johnson') // gap filled from source
    expect(merged.title).toBe('Analyst') // target wins
    expect(merged.phone).toBe('+1 555 0199') // gap filled

    const gone = await owner.contact.findUnique({ where: { id: sourceId } })
    expect(gone).toBeNull()
  })
})

describe('scoring', () => {
  const base = {
    id: 'c1', title: null, emailStatus: 'unverified', enrichedAt: null,
    unsubscribedAt: null, bouncedAt: null,
  } as unknown as Contact

  const noSignals = {
    opens: 0, clicks: 0, replies: 0, formSubmissions: 0, daysSinceLastActivity: null,
  }

  it('separates fit from engagement', () => {
    const s = computeScore({
      contact: { ...base, title: 'VP of Sales', emailStatus: 'valid' } as Contact,
      account: { employeeCount: 200 } as Account,
      signals: noSignals,
    })
    expect(s.fit).toBeGreaterThan(0)
    expect(s.engagement).toBe(0)
    expect(s.applied.map((a) => a.key)).toContain('title_senior')
    expect(s.applied.map((a) => a.key)).toContain('function_match')
  })

  it('rewards a reply most heavily', () => {
    const quiet = computeScore({ contact: base, account: null, signals: noSignals })
    const replied = computeScore({
      contact: base, account: null, signals: { ...noSignals, replies: 1 },
    })
    expect(replied.total - quiet.total).toBe(40)
  })

  it('never returns a negative total', () => {
    const s = computeScore({
      contact: { ...base, unsubscribedAt: new Date(), bouncedAt: new Date() } as Contact,
      account: null,
      signals: { ...noSignals, daysSinceLastActivity: 400 },
    })
    expect(s.total).toBe(0)
  })

  it('caps at 100 however many rules fire', () => {
    const s = computeScore({
      contact: {
        ...base, title: 'Chief Revenue Officer', emailStatus: 'valid', enrichedAt: new Date(),
      } as Contact,
      account: { employeeCount: 500 } as Account,
      signals: { opens: 5, clicks: 3, replies: 2, formSubmissions: 1, daysSinceLastActivity: 1 },
    })
    expect(s.total).toBe(100)
  })

  it('bands scores for the UI', () => {
    expect(scoreBand(80).label).toBe('Hot')
    expect(scoreBand(40).label).toBe('Warm')
    expect(scoreBand(5).label).toBe('Cold')
  })
})

describe('scoring — junior titles', () => {
  const base = {
    id: 'c2', title: null, emailStatus: 'valid', enrichedAt: null,
    unsubscribedAt: null, bouncedAt: null,
  } as unknown as Contact

  const noSignals = {
    opens: 0, clicks: 0, replies: 0, formSubmissions: 0, daysSinceLastActivity: null,
  }

  it('does not let a well-sized company carry an unqualified individual', () => {
    // The bug this guards: firmographics alone (company size + verified email)
    // pushed an intern to 45, which reads as "Warm" in the UI.
    const intern = computeScore({
      contact: { ...base, title: 'Intern' } as Contact,
      account: { employeeCount: 500 } as Account,
      signals: noSignals,
    })
    expect(scoreBand(intern.total).label).toBe('Cold')
    expect(intern.applied.map((a) => a.key)).toContain('title_junior')
  })

  it('still rates a senior buyer at the same company highly', () => {
    const vp = computeScore({
      contact: { ...base, title: 'VP of Sales' } as Contact,
      account: { employeeCount: 500 } as Account,
      signals: noSignals,
    })
    expect(vp.total).toBeGreaterThan(50)
  })
})
