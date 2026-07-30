import type { JobMap, JobName } from '../lib/queue'
import { logger } from '../lib/logger'
import { prismaAdmin } from '../lib/db'
import { pollDueMailboxes, pollMailbox } from './jobs/replies'
import { recordHeartbeat } from '../lib/health'
import { QUEUE } from '../lib/queue'
import { enrichContacts, enrichAccounts, recomputeScores } from './jobs/enrichment'
import { processEnrollmentStep, enrollContacts, sequenceTick as tick } from './jobs/sequence'
import { crmPull, crmPush, crmSyncAll, crmSyncDue, crmLogActivity } from './jobs/crm'

type Handler<N extends JobName> = (data: JobMap[N]) => Promise<unknown>

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

/**
 * Writes the liveness key the web app reads.
 *
 * Deliberately a queued job rather than a `setInterval` in the worker process: an
 * interval proves the process is up, while this proves the process is still
 * *draining its queues*. A worker that is running but wedged on a poisoned job is
 * exactly as useless as one that has crashed, and only the second check notices.
 */
const heartbeat: Handler<'maintenance:heartbeat'> = async () => {
  await recordHeartbeat(Object.values(QUEUE))
  return { ok: true }
}

export const handlers: { [N in JobName]?: Handler<N> } = {
  'sequence:tick': tick,
  'sequence:step': processEnrollmentStep,
  'sequence:enroll': enrollContacts,
  'email:send': notYetImplemented('Phase 3'),
  'email:poll-replies': pollMailbox,
  'email:poll-due': pollDueMailboxes,
  'enrichment:contact': enrichContacts,
  'enrichment:account': enrichAccounts,
  'crm:pull': crmPull,
  'crm:push': crmPush,
  'crm:sync': crmSyncAll,
  'crm:sync-due': crmSyncDue,
  'crm:log-activity': crmLogActivity,
  'scoring:recompute': recomputeScores,
  'maintenance:reset-daily-caps': resetDailyCaps,
  'maintenance:expire-sessions': expireSessions,
  'maintenance:heartbeat': heartbeat,
}
