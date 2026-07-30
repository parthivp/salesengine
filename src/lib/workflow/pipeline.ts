import { db, tid } from '../db'
import type { Deal, PipelineStage } from '@prisma/client'

/**
 * Pipeline.
 *
 * Two things here earn their keep beyond CRUD:
 *
 *  - **Rotting detection.** A pipeline nobody prunes inflates the forecast and
 *    hides which deals are actually alive. Staleness is judged against a
 *    per-stage threshold, because a week's silence in Negotiation means something
 *    very different from a week in Prospecting.
 *  - **Weighted forecast.** Summing open deal values is the number every rep
 *    quotes and every finance team distrusts. Weighting by stage probability is
 *    the minimum honest version.
 */

/** Days of silence before a deal in each stage is considered stalled. */
export const ROT_THRESHOLD_DAYS: Record<string, number> = {
  Prospecting: 21,
  Discovery: 14,
  Proposal: 10,
  Negotiation: 7,
}
const DEFAULT_ROT_DAYS = 14

export function rotDaysFor(stageName: string): number {
  return ROT_THRESHOLD_DAYS[stageName] ?? DEFAULT_ROT_DAYS
}

export type DealHealth = {
  status: 'fresh' | 'watch' | 'rotting'
  daysSinceActivity: number | null
  threshold: number
  reason?: string
}

export function assessDeal(
  deal: Pick<Deal, 'lastActivityAt' | 'updatedAt' | 'expectedCloseDate' | 'closedAt'>,
  stage: Pick<PipelineStage, 'name' | 'isWon' | 'isLost'>,
  now = new Date()
): DealHealth {
  const threshold = rotDaysFor(stage.name)

  // Closed deals cannot rot; judging them would flood the board with noise.
  if (stage.isWon || stage.isLost || deal.closedAt) {
    return { status: 'fresh', daysSinceActivity: null, threshold }
  }

  const last = deal.lastActivityAt ?? deal.updatedAt
  const days = Math.floor((now.getTime() - last.getTime()) / 86_400_000)

  // A close date in the past is a stronger signal than silence: the deal is
  // either won, lost, or the forecast is wrong. All three need attention.
  if (deal.expectedCloseDate && deal.expectedCloseDate < now) {
    return {
      status: 'rotting',
      daysSinceActivity: days,
      threshold,
      reason: `Expected close date passed ${Math.floor(
        (now.getTime() - deal.expectedCloseDate.getTime()) / 86_400_000
      )} days ago`,
    }
  }

  if (days >= threshold) {
    return {
      status: 'rotting',
      daysSinceActivity: days,
      threshold,
      reason: `No activity for ${days} days (${stage.name} threshold is ${threshold})`,
    }
  }
  if (days >= Math.ceil(threshold * 0.6)) {
    return { status: 'watch', daysSinceActivity: days, threshold }
  }
  return { status: 'fresh', daysSinceActivity: days, threshold }
}

export type Forecast = {
  openCount: number
  openValue: number
  weightedValue: number
  wonValue: number
  lostValue: number
  winRate: number | null
  avgDealSize: number | null
  avgSalesCycleDays: number | null
}

/**
 * Win rate is computed over *closed* deals only. Including open ones understates
 * it early in a quarter and makes the number useless for comparison.
 */
export function computeForecast(
  deals: (Pick<Deal, 'value' | 'closedAt' | 'createdAt'> & {
    stage: Pick<PipelineStage, 'probability' | 'isWon' | 'isLost'>
  })[]
): Forecast {
  let openCount = 0
  let openValue = 0
  let weightedValue = 0
  let wonValue = 0
  let lostValue = 0
  let wonCount = 0
  let lostCount = 0
  let cycleDaysTotal = 0
  let cycleCount = 0

  for (const d of deals) {
    const value = Number(d.value)

    if (d.stage.isWon) {
      wonValue += value
      wonCount++
      if (d.closedAt) {
        cycleDaysTotal += Math.max(
          0,
          (d.closedAt.getTime() - d.createdAt.getTime()) / 86_400_000
        )
        cycleCount++
      }
      continue
    }
    if (d.stage.isLost) {
      lostValue += value
      lostCount++
      continue
    }

    openCount++
    openValue += value
    weightedValue += value * (d.stage.probability / 100)
  }

  const closed = wonCount + lostCount

  return {
    openCount,
    openValue,
    weightedValue: Math.round(weightedValue),
    wonValue,
    lostValue,
    winRate: closed > 0 ? (wonCount / closed) * 100 : null,
    avgDealSize: wonCount > 0 ? Math.round(wonValue / wonCount) : null,
    avgSalesCycleDays: cycleCount > 0 ? Math.round(cycleDaysTotal / cycleCount) : null,
  }
}

/**
 * Moves a deal and records it. Stage changes are the events a manager reviews, so
 * they are written to the timeline rather than only mutating a column.
 */
export async function moveDeal(opts: {
  dealId: string
  toStageId: string
  actorId: string
}): Promise<Deal> {
  const { dealId, toStageId, actorId } = opts

  const [deal, toStage] = await Promise.all([
    db().deal.findUniqueOrThrow({ where: { id: dealId }, include: { stage: true } }),
    db().pipelineStage.findUniqueOrThrow({ where: { id: toStageId } }),
  ])

  if (deal.stageId === toStageId) return deal

  const closing = toStage.isWon || toStage.isLost

  const updated = await db().deal.update({
    where: { id: dealId },
    data: {
      stageId: toStageId,
      lastActivityAt: new Date(),
      closedAt: closing ? new Date() : null,
    },
  })

  await db().activity.create({
    data: {
      tenantId: tid(),
      type: 'stage_change',
      summary: `${deal.name}: ${deal.stage.name} → ${toStage.name}`,
      detail: { from: deal.stage.name, to: toStage.name, value: Number(deal.value) },
      accountId: deal.accountId,
      contactId: deal.contactId,
      actorId,
    },
  })

  // Winning a deal should mark the contact a customer; losing it should not
  // silently leave them "qualified" forever.
  if (deal.contactId) {
    if (toStage.isWon) {
      await db().contact.update({ where: { id: deal.contactId }, data: { status: 'customer' } })
    } else if (toStage.isLost) {
      await db().contact.update({ where: { id: deal.contactId }, data: { status: 'unqualified' } })
    }
  }

  // A closed deal's open tasks are noise in the rep's queue.
  if (closing) {
    await db().task.updateMany({
      where: { dealId, status: 'open' },
      data: { status: 'skipped', outcome: `Deal ${toStage.isWon ? 'won' : 'lost'}` },
    })
  }

  return updated
}

/** Ensures a tenant has a usable pipeline; called on first visit to the board. */
export async function ensureDefaultStages(): Promise<PipelineStage[]> {
  const existing = await db().pipelineStage.findMany({ orderBy: { order: 'asc' } })
  if (existing.length) return existing

  const defaults = [
    { name: 'Prospecting', order: 1, probability: 10 },
    { name: 'Discovery', order: 2, probability: 25 },
    { name: 'Proposal', order: 3, probability: 50 },
    { name: 'Negotiation', order: 4, probability: 75 },
    { name: 'Closed won', order: 5, probability: 100, isWon: true },
    { name: 'Closed lost', order: 6, probability: 0, isLost: true },
  ]

  for (const s of defaults) {
    await db().pipelineStage.create({ data: { tenantId: tid(), ...s } })
  }

  return db().pipelineStage.findMany({ orderBy: { order: 'asc' } })
}
