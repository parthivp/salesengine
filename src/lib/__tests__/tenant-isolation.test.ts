import { describe, it, expect, beforeAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

/**
 * These tests exist because tenant isolation is the one bug class that ends the
 * business. They talk to a real Postgres with RLS applied — mocking here would
 * test nothing, since the property under test is enforced by the database.
 *
 * Requires a migrated database. The fixtures these assertions need are created
 * here rather than assumed from `db:seed` — a test that fails because somebody
 * tidied up a demo record is a test that gets ignored, and this is the one suite
 * that must never be ignored.
 */

const appUrl = process.env.DATABASE_URL!
const ownerUrl = process.env.DIRECT_DATABASE_URL ?? appUrl

const app = new PrismaClient({ datasources: { db: { url: appUrl } } })
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } })

let acmeId: string
let globexId: string

beforeAll(async () => {
  const acme = await owner.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  const globex = await owner.tenant.findUniqueOrThrow({ where: { slug: 'globex' } })
  acmeId = acme.id
  globexId = globex.id

  // The record the cross-tenant reads are checked against. Upserted so the suite
  // is idempotent and independent of whatever else is in the database.
  await owner.account.upsert({
    where: { tenantId_domain: { tenantId: globexId, domain: 'globex-secret.test' } },
    update: {},
    create: { tenantId: globexId, name: 'Globex Secret Holdings', domain: 'globex-secret.test' },
  })

  // Both tenants need at least one user for the "only its own users" assertions.
  for (const [tenantId, email] of [[acmeId, 'iso-acme@test.local'], [globexId, 'iso-globex@test.local']] as const) {
    await owner.user.upsert({
      where: { tenantId_email: { tenantId, email } },
      update: {},
      create: { tenantId, email, name: 'Isolation Fixture', role: 'rep', status: 'active' },
    })
  }
})

/** Mirrors withTenant() without importing the Next-coupled module. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`
    return fn(tx as unknown as PrismaClient)
  })
}

describe('tenant isolation (Postgres RLS)', () => {
  it('shows a tenant only its own users', async () => {
    const acmeUsers = await asTenant(acmeId, (tx) => tx.user.findMany())
    expect(acmeUsers.length).toBeGreaterThan(0)
    expect(acmeUsers.every((u) => u.tenantId === acmeId)).toBe(true)
    expect(acmeUsers.some((u) => u.email === 'admin@globex.test')).toBe(false)
  })

  it('hides another tenant\'s accounts even from an unfiltered query', async () => {
    const rows = await asTenant(acmeId, (tx) => tx.account.findMany())
    expect(rows.some((a) => a.domain === 'globex-secret.test')).toBe(false)
  })

  it('returns nothing when no tenant context is set (fail-closed)', async () => {
    const rows = await app.account.findMany()
    expect(rows).toHaveLength(0)
  })

  it('rejects a write that would plant a row in another tenant', async () => {
    await expect(
      asTenant(acmeId, (tx) =>
        tx.account.create({
          data: { tenantId: globexId, name: 'Injected', domain: 'injected.test' },
        })
      )
    ).rejects.toThrow()
  })

  it('cannot read a specific foreign record by its primary key', async () => {
    const secret = await owner.account.findFirstOrThrow({
      where: { domain: 'globex-secret.test' },
    })
    const found = await asTenant(acmeId, (tx) =>
      tx.account.findUnique({ where: { id: secret.id } })
    )
    expect(found).toBeNull()
  })

  it('scopes counts per tenant, and the parts sum to the whole', async () => {
    // Enumerate every tenant rather than assuming there are only two — other
    // suites create their own, and a test that breaks when a tenant is added is
    // testing the fixture, not the isolation.
    const tenants = await owner.tenant.findMany({ select: { id: true } })
    const counts = await Promise.all(
      tenants.map((t) => asTenant(t.id, (tx) => tx.user.count()))
    )
    const total = await owner.user.count()

    expect(counts.reduce((a, b) => a + b, 0)).toBe(total)

    const acmeCount = await asTenant(acmeId, (tx) => tx.user.count())
    const globexCount = await asTenant(globexId, (tx) => tx.user.count())
    expect(acmeCount).toBeGreaterThan(0)
    expect(globexCount).toBeGreaterThan(0)
    // Neither tenant can see the other's users, so neither count is the total.
    expect(acmeCount).toBeLessThan(total)
    expect(globexCount).toBeLessThan(total)
  })
})
