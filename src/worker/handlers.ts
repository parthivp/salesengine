import type { JobMap, JobName } from '../lib/queue'
import { logger } from '../lib/logger'
import { prismaAdmin, withTenant, db } from '../lib/db'
import { enqueue } from '../lib/queue'
import { enrichContacts, enrichAccounts, recomputeScores } from './jobs/enrichment'
import { processEnrollmentStep, enrollContacts, sequenceTick as tick } from './jobs/sequence'

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

export const handlers: { [N in JobName]?: Handler<N> } = {
  'sequence:tick': tick,
  'sequence:step': processEnrollmentStep,
  'sequence:enroll': enrollContacts,
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
