import { db } from '../db'
import type { Prisma } from '@prisma/client'

/**
 * Reporting.
 *
 * The rule throughout: never present a rate computed from a denominator too small
 * to mean anything. A rep with 3 sends and 1 reply is not a 33% performer, and
 * showing that number gets people managed on noise. Rates below the floor are
 * returned as null and the UI shows a dash.
 */

export const MIN_DENOMINATOR = 20

export function rate(numerator: number, denominator: number, floor = MIN_DENOMINATOR): number | null {
  if (denominator < floor) return null
  return (numerator / denominator) * 100
}

// ---------------------------------------------------------------------------
// Sequence funnel
// ---------------------------------------------------------------------------

export type FunnelStage = { label: string; count: number; pctOfTop: number | null }

export type SequenceFunnel = {
  sequenceId: string
  name: string
  enrolled: number
  sent: number
  delivered: number
  opened: number
  clicked: number
  replied: number
  meetings: number
  bounced: number
  unsubscribed: number
  replyRate: number | null
  bounceRate: number | null
  stages: FunnelStage[]
}

export async function sequenceFunnels(limit = 10): Promise<SequenceFunnel[]> {
  const sequences = await db().sequence.findMany({
    where: { status: { in: ['active', 'paused'] } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, name: true },
  })

  const funnels: SequenceFunnel[] = []

  for (const seq of sequences) {
    const where: Prisma.EmailMessageWhereInput = { enrollment: { sequenceId: seq.id } }

    const [enrolled, sent, delivered, opened, clicked, replied, bounced, unsubscribed, meetings] =
      await Promise.all([
        db().sequenceEnrollment.count({ where: { sequenceId: seq.id } }),
        db().emailMessage.count({ where: { ...where, sentAt: { not: null } } }),
        db().emailMessage.count({ where: { ...where, deliveredAt: { not: null } } }),
        db().emailMessage.count({ where: { ...where, opensCount: { gt: 0 } } }),
        db().emailMessage.count({ where: { ...where, clicksCount: { gt: 0 } } }),
        db().sequenceEnrollment.count({ where: { sequenceId: seq.id, status: 'stopped_replied' } }),
        db().emailMessage.count({ where: { ...where, status: 'bounced' } }),
        db().sequenceEnrollment.count({
          where: { sequenceId: seq.id, status: 'stopped_unsubscribed' },
        }),
        db().task.count({ where: { type: 'meeting', status: 'completed' } }),
      ])

    // Delivered is only meaningful once SES webhooks are wired; before that it
    // reads as zero and would make the funnel look broken. Fall back to sent.
    const effectiveDelivered = delivered > 0 ? delivered : sent

    const top = enrolled || 1
    const stages: FunnelStage[] = [
      { label: 'Enrolled', count: enrolled, pctOfTop: 100 },
      { label: 'Sent', count: sent, pctOfTop: (sent / top) * 100 },
      { label: 'Delivered', count: effectiveDelivered, pctOfTop: (effectiveDelivered / top) * 100 },
      { label: 'Opened', count: opened, pctOfTop: (opened / top) * 100 },
      { label: 'Clicked', count: clicked, pctOfTop: (clicked / top) * 100 },
      { label: 'Replied', count: replied, pctOfTop: (replied / top) * 100 },
    ]

    funnels.push({
      sequenceId: seq.id,
      name: seq.name,
      enrolled, sent, delivered: effectiveDelivered, opened, clicked, replied,
      meetings, bounced, unsubscribed,
      replyRate: rate(replied, sent),
      bounceRate: rate(bounced, sent),
      stages,
    })
  }

  return funnels
}

// ---------------------------------------------------------------------------
// Rep leaderboard
// ---------------------------------------------------------------------------

export type RepRow = {
  userId: string
  name: string
  contactsOwned: number
  sent: number
  replied: number
  replyRate: number | null
  tasksCompleted: number
  tasksOverdue: number
  meetingsBooked: number
  dealsWon: number
  wonValue: number
}

export async function repLeaderboard(): Promise<RepRow[]> {
  const users = await db().user.findMany({
    where: { status: 'active' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const now = new Date()
  const rows: RepRow[] = []

  for (const u of users) {
    const [contactsOwned, sent, replied, tasksCompleted, tasksOverdue, meetingsBooked, wonDeals] =
      await Promise.all([
        db().contact.count({ where: { ownerId: u.id } }),
        db().emailMessage.count({
          where: { direction: 'outbound', sentAt: { not: null }, contact: { ownerId: u.id } },
        }),
        db().emailMessage.count({
          where: { direction: 'inbound', contact: { ownerId: u.id } },
        }),
        db().task.count({ where: { assigneeId: u.id, status: 'completed' } }),
        db().task.count({
          where: { assigneeId: u.id, status: 'open', dueAt: { lt: now } },
        }),
        db().task.count({
          where: { assigneeId: u.id, type: 'meeting', status: 'completed' },
        }),
        db().deal.findMany({
          where: { ownerId: u.id, stage: { isWon: true } },
          select: { value: true },
        }),
      ])

    rows.push({
      userId: u.id,
      name: u.name,
      contactsOwned,
      sent,
      replied,
      replyRate: rate(replied, sent),
      tasksCompleted,
      tasksOverdue,
      meetingsBooked,
      dealsWon: wonDeals.length,
      wonValue: wonDeals.reduce((n, d) => n + Number(d.value), 0),
    })
  }

  // Ranked by outcomes, not activity. Sorting by emails sent rewards volume,
  // which is precisely the behaviour that destroys a sending domain.
  return rows.sort(
    (a, b) => b.wonValue - a.wonValue || b.meetingsBooked - a.meetingsBooked || b.replied - a.replied
  )
}

// ---------------------------------------------------------------------------
// Activity over time
// ---------------------------------------------------------------------------

export type DayPoint = { date: string; sent: number; replies: number; tasks: number }

export async function activitySeries(days = 30): Promise<DayPoint[]> {
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)
  since.setUTCDate(since.getUTCDate() - (days - 1))

  const [sentRows, replyRows, taskRows] = await Promise.all([
    db().emailMessage.findMany({
      where: { direction: 'outbound', sentAt: { gte: since } },
      select: { sentAt: true },
    }),
    db().emailMessage.findMany({
      where: { direction: 'inbound', createdAt: { gte: since } },
      select: { createdAt: true },
    }),
    db().task.findMany({
      where: { status: 'completed', completedAt: { gte: since } },
      select: { completedAt: true },
    }),
  ])

  const buckets = new Map<string, DayPoint>()
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setUTCDate(since.getUTCDate() + i)
    const key = d.toISOString().slice(0, 10)
    buckets.set(key, { date: key, sent: 0, replies: 0, tasks: 0 })
  }

  const bump = (date: Date | null, field: 'sent' | 'replies' | 'tasks') => {
    if (!date) return
    const key = date.toISOString().slice(0, 10)
    const bucket = buckets.get(key)
    if (bucket) bucket[field]++
  }

  sentRows.forEach((r) => bump(r.sentAt, 'sent'))
  replyRows.forEach((r) => bump(r.createdAt, 'replies'))
  taskRows.forEach((r) => bump(r.completedAt, 'tasks'))

  return [...buckets.values()]
}

// ---------------------------------------------------------------------------
// Deliverability summary
// ---------------------------------------------------------------------------

export type DeliverabilitySummary = {
  sent: number
  bounced: number
  complained: number
  unsubscribed: number
  bounceRate: number | null
  complaintRate: number | null
  unsubscribeRate: number | null
  /** Rendered prominently: these are the numbers that end a sending domain. */
  verdict: 'healthy' | 'watch' | 'act'
}

export async function deliverabilitySummary(): Promise<DeliverabilitySummary> {
  const [sent, bounced, complained, unsubscribed] = await Promise.all([
    db().emailMessage.count({ where: { direction: 'outbound', sentAt: { not: null } } }),
    db().emailMessage.count({ where: { status: 'bounced' } }),
    db().emailMessage.count({ where: { status: 'complained' } }),
    db().suppressionEntry.count({ where: { reason: 'unsubscribe' } }),
  ])

  const bounceRate = rate(bounced, sent, 50)
  const complaintRate = rate(complained, sent, 50)

  let verdict: DeliverabilitySummary['verdict'] = 'healthy'
  if (bounceRate != null && bounceRate >= 5) verdict = 'act'
  else if (complaintRate != null && complaintRate >= 0.1) verdict = 'act'
  else if (bounceRate != null && bounceRate >= 3) verdict = 'watch'
  else if (complaintRate != null && complaintRate >= 0.05) verdict = 'watch'

  return {
    sent, bounced, complained, unsubscribed,
    bounceRate, complaintRate,
    unsubscribeRate: rate(unsubscribed, sent, 50),
    verdict,
  }
}
