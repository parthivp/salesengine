import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { assess } from '../readiness'
import { recordHeartbeat, workerStatus, STALE_AFTER_MS } from '../health'
import { redis, closeQueues } from '../queue'

/**
 * Readiness and worker liveness.
 *
 * The failure this guards is a dashboard full of zeroes that reads as "a quiet
 * week" when the real cause is a dead worker, an unverified sending domain, or a
 * mailbox nobody polls. Those need very different responses, and none of them
 * raise an error anywhere.
 */

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

const KEY = 'salesengine:worker:heartbeat'
let tenantId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'readiness-test' },
    update: {},
    create: { slug: 'readiness-test', name: 'Readiness Test Co' },
  })
  tenantId = t.id
})

afterAll(async () => {
  await redis.del(KEY)
  await owner.$disconnect()
  await closeQueues()
})

describe('worker liveness', () => {
  it('reports a fresh heartbeat as alive', async () => {
    await recordHeartbeat(['sequence', 'email'])
    const status = await workerStatus()
    expect(status.state).toBe('alive')
    if (status.state === 'alive') {
      expect(status.queues).toContain('sequence')
      expect(status.ageMs).toBeLessThan(5000)
    }
  })

  it('reports a missing heartbeat as never seen, not as healthy', async () => {
    // The dangerous default. Absent must never read as fine.
    await redis.del(KEY)
    const status = await workerStatus()
    expect(status.state).toBe('never')
    if (status.state === 'never') {
      expect(status.message).toMatch(/will not send/i)
    }
  })

  it('reports an old heartbeat as stale', async () => {
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000)
    await redis.set(KEY, JSON.stringify({ at: old.toISOString(), pid: 1, queues: [] }), 'EX', 300)

    const status = await workerStatus()
    expect(status.state).toBe('stale')
    if (status.state === 'stale') expect(status.message).toMatch(/stopped/i)
  })

  it('does not mistake unreadable data for a healthy worker', async () => {
    await redis.set(KEY, 'not json at all', 'EX', 60)
    const status = await workerStatus()
    expect(status.state).toBe('unknown')
  })

  it('never throws out of recordHeartbeat', async () => {
    // Losing the monitoring signal is a monitoring problem; taking the worker
    // down because it could not write a heartbeat would be an outage.
    const spy = vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('redis is gone'))
    await expect(recordHeartbeat(['sequence'])).resolves.toBeUndefined()
    spy.mockRestore()
  })
})

describe('readiness assessment', () => {
  it('calls out a dead worker as a blocker', async () => {
    await redis.del(KEY)
    const r = await assess(tenantId)
    const worker = r.checks.find((c) => c.id === 'worker')
    expect(worker?.severity).toBe('blocker')
    expect(r.ready).toBe(false)
  })

  it('clears once the worker checks in', async () => {
    await recordHeartbeat(['sequence'])
    const r = await assess(tenantId)
    expect(r.checks.find((c) => c.id === 'worker')?.severity).toBe('ok')
  })

  it('treats a tenant with no mailbox as unable to send', async () => {
    const r = await assess(tenantId)
    const mailboxes = r.checks.find((c) => c.id === 'mailboxes')
    expect(mailboxes?.severity).toBe('blocker')
    expect(mailboxes?.fix).toBeTruthy()
  })

  it('warns that unpolled mailboxes mean replies are never seen', async () => {
    const r = await assess(tenantId)
    const replies = r.checks.find((c) => c.id === 'reply-polling')
    expect(replies?.severity).toBe('warning')
    expect(replies?.detail).toMatch(/keep sending to people who have answered/i)
  })

  it('confirms the tenant-isolation backstop is on in this environment', async () => {
    // If this fails, the test database connection is the owner role and the
    // isolation suite is not proving what it claims to prove.
    const r = await assess(tenantId)
    expect(r.checks.find((c) => c.id === 'db-role')?.severity).toBe('ok')
  })

  it('gives every failing check something to do about it', async () => {
    const r = await assess(tenantId)
    for (const c of r.checks.filter((x) => x.severity === 'blocker' || x.severity === 'warning')) {
      expect(c.fix, `${c.id} has no fix`).toBeTruthy()
    }
  })

  it('counts blockers and warnings consistently with the check list', async () => {
    const r = await assess(tenantId)
    expect(r.blockers).toBe(r.checks.filter((c) => c.severity === 'blocker').length)
    expect(r.warnings).toBe(r.checks.filter((c) => c.severity === 'warning').length)
    expect(r.ready).toBe(r.blockers === 0)
  })
})
