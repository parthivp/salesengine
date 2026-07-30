import { db } from '../db'
import type { Contact, Account } from '@prisma/client'

/**
 * Lead scoring, split into two axes because they answer different questions:
 *
 *   fit        — should we be talking to this person at all? (title, company size)
 *   engagement — are they showing interest? (opens, clicks, replies)
 *
 * A high-fit / zero-engagement contact belongs in a sequence. A low-fit /
 * high-engagement contact is usually a job applicant or a competitor, and
 * collapsing both into one number hides that.
 */

export type ScoreRule = {
  key: string
  label: string
  axis: 'fit' | 'engagement'
  points: number
  test: (ctx: ScoreContext) => boolean
}

export type ScoreContext = {
  contact: Contact
  account: Account | null
  signals: {
    opens: number
    clicks: number
    replies: number
    formSubmissions: number
    daysSinceLastActivity: number | null
  }
}

const SENIOR_TITLE =
  /\b(chief|c[etoi]o|cxo|founder|owner|president|vp|vice[- ]president|head of|director|partner)\b/i
const MANAGER_TITLE = /\b(manager|lead|principal|senior)\b/i
const JUNIOR_TITLE = /\b(intern|trainee|apprentice|assistant|junior|jr\.?|graduate|student)\b/i
const BUYER_FUNCTION = /\b(sales|revenue|growth|marketing|demand|bizdev|business development)\b/i

export const RULES: ScoreRule[] = [
  // --- fit -----------------------------------------------------------------
  {
    key: 'title_senior', label: 'Senior title', axis: 'fit', points: 20,
    test: ({ contact }) => SENIOR_TITLE.test(contact.title ?? ''),
  },
  {
    key: 'title_manager', label: 'Manager-level title', axis: 'fit', points: 10,
    test: ({ contact }) => !SENIOR_TITLE.test(contact.title ?? '') && MANAGER_TITLE.test(contact.title ?? ''),
  },
  {
    // Without this, a company that fits drags an unqualified individual into
    // "Warm" on firmographics alone — an intern at a 500-person target scored 45.
    key: 'title_junior', label: 'Junior title', axis: 'fit', points: -20,
    test: ({ contact }) => JUNIOR_TITLE.test(contact.title ?? ''),
  },
  {
    key: 'function_match', label: 'Relevant function', axis: 'fit', points: 15,
    test: ({ contact }) => BUYER_FUNCTION.test(contact.title ?? ''),
  },
  {
    key: 'company_size', label: 'Company 50–5000 employees', axis: 'fit', points: 15,
    test: ({ account }) =>
      account?.employeeCount != null && account.employeeCount >= 50 && account.employeeCount <= 5000,
  },
  {
    key: 'has_verified_email', label: 'Verified email', axis: 'fit', points: 10,
    test: ({ contact }) => contact.emailStatus === 'valid',
  },
  {
    key: 'enriched', label: 'Enriched record', axis: 'fit', points: 5,
    test: ({ contact }) => contact.enrichedAt != null,
  },

  // --- engagement ----------------------------------------------------------
  {
    key: 'replied', label: 'Replied to an email', axis: 'engagement', points: 40,
    test: ({ signals }) => signals.replies > 0,
  },
  {
    key: 'clicked', label: 'Clicked a link', axis: 'engagement', points: 20,
    test: ({ signals }) => signals.clicks > 0,
  },
  {
    key: 'multi_open', label: 'Opened more than once', axis: 'engagement', points: 10,
    test: ({ signals }) => signals.opens > 1,
  },
  {
    key: 'form_submitted', label: 'Submitted a form', axis: 'engagement', points: 25,
    test: ({ signals }) => signals.formSubmissions > 0,
  },

  // --- decay ---------------------------------------------------------------
  {
    key: 'stale', label: 'No activity in 90 days', axis: 'engagement', points: -15,
    test: ({ signals }) =>
      signals.daysSinceLastActivity != null && signals.daysSinceLastActivity > 90,
  },
  {
    key: 'unsubscribed', label: 'Unsubscribed', axis: 'engagement', points: -50,
    test: ({ contact }) => contact.unsubscribedAt != null,
  },
  {
    key: 'bounced', label: 'Email bounced', axis: 'fit', points: -40,
    test: ({ contact }) => contact.bouncedAt != null,
  },
]

export type ScoreBreakdown = {
  total: number
  fit: number
  engagement: number
  applied: { key: string; label: string; points: number }[]
}

export function computeScore(ctx: ScoreContext): ScoreBreakdown {
  const applied: ScoreBreakdown['applied'] = []
  let fit = 0
  let engagement = 0

  for (const rule of RULES) {
    let hit = false
    try {
      hit = rule.test(ctx)
    } catch {
      hit = false
    }
    if (!hit) continue
    applied.push({ key: rule.key, label: rule.label, points: rule.points })
    if (rule.axis === 'fit') fit += rule.points
    else engagement += rule.points
  }

  // Clamp so a single negative rule cannot drive the score below zero, and so
  // the number stays comparable across contacts.
  const total = Math.max(0, Math.min(100, fit + engagement))
  return { total, fit, engagement, applied }
}

/** Recomputes and persists, writing a ScoreEvent only when the value moves. */
export async function rescoreContact(contactId: string): Promise<ScoreBreakdown> {
  const contact = await db().contact.findUniqueOrThrow({ where: { id: contactId } })
  const account = contact.accountId
    ? await db().account.findUnique({ where: { id: contact.accountId } })
    : null

  const [opens, clicks, replies] = await Promise.all([
    db().emailMessage.aggregate({ where: { contactId }, _sum: { opensCount: true } }),
    db().emailMessage.aggregate({ where: { contactId }, _sum: { clicksCount: true } }),
    db().emailMessage.count({ where: { contactId, direction: 'inbound' } }),
  ])

  const lastActivity = await db().activity.findFirst({
    where: { contactId },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  })

  const breakdown = computeScore({
    contact,
    account,
    signals: {
      opens: opens._sum.opensCount ?? 0,
      clicks: clicks._sum.clicksCount ?? 0,
      replies,
      formSubmissions: contact.source === 'form' ? 1 : 0,
      daysSinceLastActivity: lastActivity
        ? Math.floor((Date.now() - lastActivity.occurredAt.getTime()) / 86_400_000)
        : null,
    },
  })

  if (breakdown.total !== contact.score) {
    await db().contact.update({ where: { id: contactId }, data: { score: breakdown.total } })
    await db().scoreEvent.create({
      data: {
        contactId,
        rule: 'recompute',
        delta: breakdown.total - contact.score,
        reason: breakdown.applied.map((a) => a.label).join(', ') || 'No rules matched',
      },
    })
  }

  return breakdown
}

export function scoreBand(score: number): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (score >= 60) return { label: 'Hot', tone: 'success' }
  if (score >= 30) return { label: 'Warm', tone: 'warning' }
  return { label: 'Cold', tone: 'neutral' }
}
