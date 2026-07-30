import { db, tid } from './db'
import { logger } from './logger'

/**
 * Plan limits, enforced.
 *
 * `enrichCreditLimit` was the only one of the three that anything checked.
 * `monthlyEmailLimit` and `seatLimit` sat in the schema, were shown in the UI, and
 * bounded nothing — a runaway sequence could send without limit and a workspace
 * could add users past its seat count. A limit that is displayed but not enforced
 * is worse than no limit: it tells the operator they are protected.
 *
 * The email counter is incremented at the point of sending rather than when a
 * message is queued, so a queue that is drained twice cannot double-count, and a
 * send that fails does not consume quota.
 */

export type LimitCheck = {
  allowed: boolean
  used: number
  limit: number
  remaining: number
  reason?: string
}

/** Calendar month, UTC. Matches the UsageCounter `period` format. */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export const METRIC = {
  emailsSent: 'emails_sent',
  enrichCredits: 'enrich_credits',
  apiCalls: 'api_calls',
} as const

export async function usage(metric: string, period = currentPeriod()): Promise<number> {
  const row = await db().usageCounter.findUnique({
    where: { tenantId_period_metric: { tenantId: tid(), period, metric } },
    select: { value: true },
  })
  return row?.value ?? 0
}

/**
 * Adds to a usage counter and returns the new total.
 *
 * Upsert plus atomic increment: two workers sending concurrently must not lose a
 * count to a read-modify-write race, which is exactly how a quota silently drifts
 * under load and stops meaning anything.
 */
export async function recordUsage(metric: string, by = 1, period = currentPeriod()): Promise<number> {
  const row = await db().usageCounter.upsert({
    where: { tenantId_period_metric: { tenantId: tid(), period, metric } },
    update: { value: { increment: by } },
    create: { tenantId: tid(), period, metric, value: by },
    select: { value: true },
  })
  return row.value
}

/** Whether this tenant may send another `count` emails this month. */
export async function checkEmailQuota(count = 1): Promise<LimitCheck> {
  const tenant = await db().tenant.findUniqueOrThrow({
    where: { id: tid() },
    select: { monthlyEmailLimit: true },
  })
  const used = await usage(METRIC.emailsSent)
  const limit = tenant.monthlyEmailLimit
  const remaining = Math.max(0, limit - used)

  if (used + count > limit) {
    return {
      allowed: false,
      used,
      limit,
      remaining,
      reason: `This workspace has sent ${used.toLocaleString()} of its ${limit.toLocaleString()} emails this month.`,
    }
  }
  return { allowed: true, used, limit, remaining }
}

/** Whether this tenant may activate another user. */
export async function checkSeatQuota(count = 1): Promise<LimitCheck> {
  const tenant = await db().tenant.findUniqueOrThrow({
    where: { id: tid() },
    select: { seatLimit: true },
  })
  // Invited-but-not-accepted users hold a seat. Otherwise a workspace can invite
  // past its limit and only discover it when people try to sign in.
  const used = await db().user.count({ where: { status: { in: ['active', 'invited'] } } })
  const limit = tenant.seatLimit
  const remaining = Math.max(0, limit - used)

  if (used + count > limit) {
    return {
      allowed: false,
      used,
      limit,
      remaining,
      reason: `This workspace uses ${used} of its ${limit} seats.`,
    }
  }
  return { allowed: true, used, limit, remaining }
}

/**
 * Records a send against the monthly quota.
 *
 * Logs on crossing the threshold rather than throwing: the send already happened,
 * and the check that prevents the next one runs before it.
 */
export async function recordEmailSent(count = 1): Promise<void> {
  const total = await recordUsage(METRIC.emailsSent, count)
  const tenant = await db().tenant.findUnique({
    where: { id: tid() },
    select: { monthlyEmailLimit: true },
  })
  if (tenant && total >= tenant.monthlyEmailLimit) {
    logger.warn(
      { tenantId: tid(), used: total, limit: tenant.monthlyEmailLimit },
      'monthly email limit reached; further sends will be refused until next month'
    )
  }
}
