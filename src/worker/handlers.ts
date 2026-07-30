import type { JobMap, JobName } from '../lib/queue'
import { logger } from '../lib/logger'
import { prismaAdmin, withTenant, db } from '../lib/db'
import { enqueue } from '../lib/queue'
import { enrichContacts, enrichAccounts, recomputeScores } from './jobs/enrichment'

type Handler<N extends JobName> = (data: JobMap[N]) => Promise<unknown>

/**
 * The scheduler tick. Runs every minute.
 *
 * It does not do work — it finds enrollments that are due and fans out one job
 * per enrollment. This keeps the tick fast and bounded regardless of how many
 * contacts are enrolled, and means a slow send cannot stall the whole schedule.
 */
const sequenceTick: Handler<'sequence:tick'> = async () => {
  const due = await prismaAdmin.sequenceEnrollment.findMany({
    where: {
      status: 'active',
      nextRunAt: { lte: new Date() },
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - 5 * 60_000) } }],
    },
    select: { id: true, tenantId: true },
    take: 1000,
    orderBy: { nextRunAt: 'asc' },
  })

  for (const e of due) {
    await enqueue(
      'sequence:step',
      { enrollmentId: e.id, tenantId: e.tenantId },
      // Idempotent within the minute: a duplicate tick cannot double-enqueue.
      { jobId: `step:${e.id}:${Math.floor(Date.now() / 60_000)}` }
    )
  }

  if (due.length) logger.info({ count: due.length }, 'sequence tick fanned out')
  return { dispatched: due.length }
}

/** Phase 3 implements the step machine. Registered now so the wiring is testable. */
const sequenceStep: Handler<'sequence:step'> = async ({ enrollmentId, tenantId }) => {
  return withTenant(tenantId, async () => {
    const enrollment = await db().sequenceEnrollment.findUnique({ where: { id: enrollmentId } })
    if (!enrollment || enrollment.status !== 'active') return { skipped: true }
    logger.debug({ enrollmentId }, 'sequence step — engine lands in Phase 3')
    return { pending: true }
  })
}

/** Resets per-mailbox daily counters and advances warm-up ramps. */
const resetDailyCaps: Handler<'maintenance:reset-daily-caps'> = async () => {
  const mailboxes = await prismaAdmin.mailbox.findMany({
    where: { health: { in: ['healthy', 'warming'] } },
    select: { id: true, warmupDay: true, warmupTarget: true, dailyCap: true, health: true },
  })

  let advanced = 0
  for (const m of mailboxes) {
    const nextDay = m.warmupDay + 1
    // ~20% per week compounding, capped at the configured target.
    const rampedCap =
      m.health === 'warming'
        ? Math.min(m.warmupTarget, Math.ceil(20 * Math.pow(1.2, Math.floor(nextDay / 7))))
        : m.dailyCap

    await prismaAdmin.mailbox.update({
      where: { id: m.id },
      data: {
        sentToday: 0,
        sentTodayOn: new Date(),
        warmupDay: nextDay,
        dailyCap: rampedCap,
        health: m.health === 'warming' && rampedCap >= m.warmupTarget ? 'healthy' : m.health,
      },
    })
    advanced++
  }

  logger.info({ mailboxes: advanced }, 'daily caps reset')
  return { mailboxes: advanced }
}

const expireSessions: Handler<'maintenance:expire-sessions'> = async () => {
  const { count } = await prismaAdmin.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  logger.info({ count }, 'expired sessions purged')
  return { count }
}

function notYetImplemented<N extends JobName>(phase: string): Handler<N> {
  return async (data) => {
    logger.debug({ data }, `handler lands in ${phase}`)
    return { pending: true }
  }
}

export const handlers: { [N in JobName]?: Handler<N> } = {
  'sequence:tick': sequenceTick,
  'sequence:step': sequenceStep,
  'sequence:enroll': notYetImplemented('Phase 3'),
  'email:send': notYetImplemented('Phase 3'),
  'email:poll-replies': notYetImplemented('Phase 3'),
  'enrichment:contact': enrichContacts,
  'enrichment:account': enrichAccounts,
  'crm:pull': notYetImplemented('Phase 4'),
  'crm:push': notYetImplemented('Phase 4'),
  'scoring:recompute': recomputeScores,
  'maintenance:reset-daily-caps': resetDailyCaps,
  'maintenance:expire-sessions': expireSessions,
}
