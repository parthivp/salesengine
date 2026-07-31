import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant } from '../db'
import { usage } from '../limits'

/**
 * Enrichment had no tests at all, which is part of why nothing noticed that the
 * jobs were registered as handlers and never enqueued by anything.
 *
 * Apollo is mocked rather than called: these tests are about the accounting and
 * the write path, and a test that spends real credits is a test nobody runs.
 */

vi.mock('../apollo', async () => {
  const actual = await vi.importActual<typeof import('../apollo')>('../apollo')
  return {
    ...actual,
    apolloEnabled: () => true,
    enrichOrganization: vi.fn(),
    bulkEnrichPeople: vi.fn(),
  }
})

const { enrichAccounts } = await import('../../worker/jobs/enrichment')
const apollo = await import('../apollo')
const enrichOrganization = vi.mocked(apollo.enrichOrganization)

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'enrich-test' },
    update: {},
    create: { slug: 'enrich-test', name: 'Enrich Test Co', enrichCreditLimit: 100 },
  })
  tenantId = t.id
})

beforeEach(async () => {
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.usageCounter.deleteMany({ where: { tenantId } })
  enrichOrganization.mockReset()
})

afterAll(async () => {
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.usageCounter.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

async function seedAccount(name: string, domain: string) {
  return owner.account.create({ data: { tenantId, name, domain } })
}

// Distinct apolloId per domain — accounts carry it, and reusing one across
// several would fail on the index for reasons that have nothing to do with what
// these tests are checking.
const org = (over: { primary_domain?: string } & Record<string, unknown> = {}) => {
  const domain = over.primary_domain ?? 'zhonglun.com'
  return {
    name: 'Zhong Lun Law Firm',
    industry: 'legal services',
    estimated_num_employees: 2500,
    ...over,
    primary_domain: domain,
    id: `apollo_${domain.replace(/\W/g, '_')}`,
  }
}

describe('account enrichment', () => {
  it('fills the fields the drafts actually read', async () => {
    const account = await seedAccount('Zhong Lun Law Firm', 'zhonglun.com')
    enrichOrganization.mockResolvedValue(org() as never)

    const r = await enrichAccounts({ tenantId, accountIds: [account.id] })
    expect(r).toMatchObject({ enriched: 1, attempted: 1 })

    const after = await owner.account.findUniqueOrThrow({ where: { id: account.id } })
    expect(after.industry).toBe('legal services')
    expect(after.employeeCount).toBe(2500)
    expect(after.enrichedAt).not.toBeNull()
  })

  it('charges for matches, not attempts', async () => {
    // The old code charged `targets.length` unconditionally, so a batch where the
    // provider knew nothing still burned the allowance.
    const [a, b, c] = await Promise.all([
      seedAccount('Known Co', 'known.test'),
      seedAccount('Unknown Co', 'unknown.test'),
      seedAccount('Also Unknown', 'nobody.test'),
    ])
    enrichOrganization.mockImplementation(async (domain: string) =>
      domain === 'known.test' ? (org({ primary_domain: domain }) as never) : null
    )

    const r = await enrichAccounts({ tenantId, accountIds: [a.id, b.id, c.id] })
    expect(r).toMatchObject({ enriched: 1, attempted: 3 })
    expect(await withTenant(tenantId, () => usage('enrich_credits'))).toBe(1)
  })

  it('charges nothing when nothing matched', async () => {
    const account = await seedAccount('Ghost Co', 'ghost.test')
    enrichOrganization.mockResolvedValue(null)

    await enrichAccounts({ tenantId, accountIds: [account.id] })
    expect(await withTenant(tenantId, () => usage('enrich_credits'))).toBe(0)
  })

  it('keeps the count straight when two batches run in the same period', async () => {
    // The counter used to be read-then-written, so concurrent batches either
    // collided on the unique index or lost a charge. It is one atomic upsert now.
    const accounts = await Promise.all([
      seedAccount('One', 'one.test'),
      seedAccount('Two', 'two.test'),
      seedAccount('Three', 'three.test'),
      seedAccount('Four', 'four.test'),
    ])
    enrichOrganization.mockImplementation(
      async (domain: string) => org({ primary_domain: domain }) as never
    )

    await Promise.all([
      enrichAccounts({ tenantId, accountIds: [accounts[0].id, accounts[1].id] }),
      enrichAccounts({ tenantId, accountIds: [accounts[2].id, accounts[3].id] }),
    ])

    expect(await withTenant(tenantId, () => usage('enrich_credits'))).toBe(4)
  })

  it('never overwrites a value a human already curated', async () => {
    const account = await owner.account.create({
      data: { tenantId, name: 'Curated Co', domain: 'curated.test', industry: 'Legal tech' },
    })
    enrichOrganization.mockResolvedValue(org({ primary_domain: 'curated.test' }) as never)

    await enrichAccounts({ tenantId, accountIds: [account.id] })
    const after = await owner.account.findUniqueOrThrow({ where: { id: account.id } })
    expect(after.industry).toBe('Legal tech')
    // The gap is still filled.
    expect(after.employeeCount).toBe(2500)
  })

  it('skips a record enriched recently rather than paying for it twice', async () => {
    const account = await owner.account.create({
      data: { tenantId, name: 'Fresh Co', domain: 'fresh.test', enrichedAt: new Date() },
    })
    const r = await enrichAccounts({ tenantId, accountIds: [account.id] })
    expect(r).toMatchObject({ enriched: 0, attempted: 0 })
    expect(enrichOrganization).not.toHaveBeenCalled()
  })

  it('stops at the credit ceiling instead of spending past it', async () => {
    await owner.tenant.update({ where: { id: tenantId }, data: { enrichCreditLimit: 1 } })
    try {
      const accounts = await Promise.all([
        seedAccount('A', 'a.test'),
        seedAccount('B', 'b.test'),
      ])
      enrichOrganization.mockImplementation(
        async (domain: string) => org({ primary_domain: domain }) as never
      )
      const r = await enrichAccounts({ tenantId, accountIds: accounts.map((a) => a.id) })
      expect(r).toMatchObject({ attempted: 1 })
      expect(enrichOrganization).toHaveBeenCalledTimes(1)
    } finally {
      await owner.tenant.update({ where: { id: tenantId }, data: { enrichCreditLimit: 100 } })
    }
  })

  it('does nothing at all when Apollo is not configured', async () => {
    vi.spyOn(apollo, 'apolloEnabled').mockReturnValueOnce(false)
    const account = await seedAccount('Nope Co', 'nope.test')
    const r = await enrichAccounts({ tenantId, accountIds: [account.id] })
    expect(r).toMatchObject({ skipped: 1, reason: 'apollo_not_configured' })
    expect(enrichOrganization).not.toHaveBeenCalled()
  })
})
