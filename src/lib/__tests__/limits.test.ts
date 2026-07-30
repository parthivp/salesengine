import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant } from '../db'
import {
  checkEmailQuota,
  checkSeatQuota,
  recordUsage,
  recordEmailSent,
  usage,
  currentPeriod,
  METRIC,
} from '../limits'

/**
 * Plan limits against real Postgres.
 *
 * `monthlyEmailLimit` and `seatLimit` were on the tenant, shown in the UI, and
 * enforced by nothing. That is worse than having no limit at all: the operator
 * reads the number and believes a runaway sequence is bounded.
 */

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'limits-test' },
    update: {},
    create: { slug: 'limits-test', name: 'Limits Test Co' },
  })
  tenantId = t.id
})

beforeEach(async () => {
  await owner.usageCounter.deleteMany({ where: { tenantId } })
  await owner.user.deleteMany({ where: { tenantId } })
  await owner.tenant.update({
    where: { id: tenantId },
    data: { monthlyEmailLimit: 100, seatLimit: 3 },
  })
})

afterAll(async () => {
  await owner.usageCounter.deleteMany({ where: { tenantId } })
  await owner.user.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

async function addUser(email: string, status: 'active' | 'invited' | 'disabled') {
  return owner.user.create({
    data: { tenantId, email, name: email, role: 'rep', status, passwordHash: 'x' },
  })
}

describe('the monthly email quota', () => {
  it('allows a send below the limit', async () => {
    const r = await withTenant(tenantId, () => checkEmailQuota())
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(100)
  })

  it('refuses the send that would cross the limit', async () => {
    await withTenant(tenantId, () => recordUsage(METRIC.emailsSent, 100))
    const r = await withTenant(tenantId, () => checkEmailQuota())
    expect(r.allowed).toBe(false)
    expect(r.used).toBe(100)
    expect(r.reason).toContain('100')
  })

  it('refuses a batch that would cross it, not just a single', async () => {
    await withTenant(tenantId, () => recordUsage(METRIC.emailsSent, 95))
    expect((await withTenant(tenantId, () => checkEmailQuota(10))).allowed).toBe(false)
    expect((await withTenant(tenantId, () => checkEmailQuota(5))).allowed).toBe(true)
  })

  it('counts per calendar month, so a quota actually resets', async () => {
    await withTenant(tenantId, () => recordUsage(METRIC.emailsSent, 100, '2026-06'))
    const r = await withTenant(tenantId, () => checkEmailQuota())
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(0)
  })

  it('increments without losing counts under concurrency', async () => {
    // The previous implementation did findFirst-then-create, so two workers
    // starting in the same month both found nothing and both inserted — a unique
    // violation on (tenantId, period, metric). Upsert plus atomic increment is
    // what makes this safe.
    await Promise.all(
      Array.from({ length: 20 }, () => withTenant(tenantId, () => recordUsage(METRIC.emailsSent, 1)))
    )
    expect(await withTenant(tenantId, () => usage(METRIC.emailsSent))).toBe(20)
  })

  it('records a send against the current period', async () => {
    await withTenant(tenantId, () => recordEmailSent())
    const row = await owner.usageCounter.findFirstOrThrow({
      where: { tenantId, metric: METRIC.emailsSent },
    })
    expect(row.value).toBe(1)
    expect(row.period).toBe(currentPeriod())
  })

  it('formats the period as YYYY-MM', () => {
    expect(currentPeriod(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01')
    expect(currentPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12')
  })
})

describe('the seat limit', () => {
  it('counts an invited user against seats', async () => {
    // Otherwise a workspace invites past its limit and only finds out when people
    // try to sign in — the worst moment to discover it.
    await addUser('a@limits.test', 'active')
    await addUser('b@limits.test', 'invited')

    const r = await withTenant(tenantId, () => checkSeatQuota())
    expect(r.used).toBe(2)
    expect(r.allowed).toBe(true)
  })

  it('does not count a disabled user', async () => {
    await addUser('a@limits.test', 'active')
    await addUser('gone@limits.test', 'disabled')

    const r = await withTenant(tenantId, () => checkSeatQuota())
    expect(r.used).toBe(1)
  })

  it('refuses the invitation that would exceed the limit', async () => {
    await addUser('a@limits.test', 'active')
    await addUser('b@limits.test', 'active')
    await addUser('c@limits.test', 'invited')

    const r = await withTenant(tenantId, () => checkSeatQuota())
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('3')
  })
})

describe('tenant isolation of usage', () => {
  it('does not count another tenant’s usage or seats', async () => {
    const other = await owner.tenant.upsert({
      where: { slug: 'limits-test-other' },
      update: {},
      create: { slug: 'limits-test-other', name: 'Other Co' },
    })
    await owner.usageCounter.create({
      data: { tenantId: other.id, period: currentPeriod(), metric: METRIC.emailsSent, value: 9999 },
    })
    await owner.user.create({
      data: { tenantId: other.id, email: 'x@other.test', name: 'X', role: 'rep', status: 'active', passwordHash: 'x' },
    })

    const quota = await withTenant(tenantId, () => checkEmailQuota())
    const seats = await withTenant(tenantId, () => checkSeatQuota())
    expect(quota.used).toBe(0)
    expect(seats.used).toBe(0)

    await owner.usageCounter.deleteMany({ where: { tenantId: other.id } })
    await owner.user.deleteMany({ where: { tenantId: other.id } })
  })
})
