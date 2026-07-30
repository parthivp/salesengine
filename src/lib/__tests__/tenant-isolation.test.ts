import { describe, it, expect, beforeAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

/**
 * These tests exist because tenant isolation is the one bug class that ends the
 * business. They talk to a real Postgres with RLS applied — mocking here would
 * test nothing, since the property under test is enforced by the database.
 *
 * Requires: docker compose -f docker-compose.dev.yml up -d && npm run db:deploy && npm run db:seed
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

  it('scopes counts per tenant', async () => {
    const acmeCount = await asTenant(acmeId, (tx) => tx.user.count())
    const globexCount = await asTenant(globexId, (tx) => tx.user.count())
    const total = await owner.user.count()
    expect(acmeCount).toBeGreaterThan(0)
    expect(globexCount).toBeGreaterThan(0)
    expect(acmeCount + globexCount).toBe(total)
  })
})
