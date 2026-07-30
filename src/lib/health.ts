import { redis } from './queue'
import { logger } from './logger'

/**
 * Worker liveness.
 *
 * If the worker process dies, sequences stop sending, replies stop being
 * ingested, and CRM sync stops — and nothing anywhere says so. The dashboard
 * keeps rendering, the enrollments stay `active`, and the only symptom is that
 * numbers quietly stop moving. For a product whose whole job is to send on a
 * schedule, that is the worst failure mode left: you believe campaigns are
 * running for a week before anyone notices they are not.
 *
 * Held in Redis rather than Postgres deliberately. The heartbeat is infrastructure
 * state, not tenant data — it has no `tenantId`, so it does not belong in a table
 * governed by row-level security, and a key with a TTL expresses "absent means
 * dead" without a cleanup job.
 */

const KEY = 'salesengine:worker:heartbeat'

/** Generous enough to survive a slow tick, short enough to notice a real death. */
const TTL_SECONDS = 300

/** Beyond this, the worker is treated as gone rather than merely slow. */
export const STALE_AFTER_MS = 180_000

export type Heartbeat = {
  at: string
  pid: number
  queues: string[]
}

export async function recordHeartbeat(queues: string[]): Promise<void> {
  const beat: Heartbeat = { at: new Date().toISOString(), pid: process.pid, queues }
  try {
    await redis.set(KEY, JSON.stringify(beat), 'EX', TTL_SECONDS)
  } catch (err) {
    // A heartbeat that cannot be written must not take the worker down with it.
    // Losing the signal is a monitoring problem; losing the worker is an outage.
    logger.warn({ err }, 'could not write worker heartbeat')
  }
}

export type WorkerStatus =
  | { state: 'never'; message: string }
  | { state: 'stale'; lastSeen: Date; ageMs: number; message: string }
  | { state: 'alive'; lastSeen: Date; ageMs: number; pid: number; queues: string[] }
  | { state: 'unknown'; message: string }

export async function workerStatus(now = new Date()): Promise<WorkerStatus> {
  let raw: string | null
  try {
    raw = await redis.get(KEY)
  } catch (err) {
    // Redis being unreachable is itself worth surfacing, and is a different
    // problem from the worker being dead — saying "worker down" here would send
    // someone to debug the wrong process.
    logger.warn({ err }, 'could not read worker heartbeat')
    return { state: 'unknown', message: 'Redis is unreachable, so worker health cannot be read.' }
  }

  if (!raw) {
    return {
      state: 'never',
      message:
        'The worker has not checked in. Sequences will not send and replies will not be collected ' +
        'until it is running.',
    }
  }

  try {
    const beat = JSON.parse(raw) as Heartbeat
    const lastSeen = new Date(beat.at)
    const ageMs = now.getTime() - lastSeen.getTime()

    if (ageMs > STALE_AFTER_MS) {
      return {
        state: 'stale',
        lastSeen,
        ageMs,
        message: `The worker last checked in ${Math.round(ageMs / 60_000)} minutes ago. Sending has probably stopped.`,
      }
    }
    return { state: 'alive', lastSeen, ageMs, pid: beat.pid, queues: beat.queues ?? [] }
  } catch {
    return { state: 'unknown', message: 'The heartbeat could not be read.' }
  }
}

export async function redisReachable(): Promise<boolean> {
  try {
    const pong = await redis.ping()
    return pong === 'PONG'
  } catch {
    return false
  }
}
