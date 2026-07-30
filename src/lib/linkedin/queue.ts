import { db, tid } from '../db'
import { draftMessage, checkDraft, type DraftContext, type Draft, type DraftCheck } from './draft'
import { SENIOR_TITLE } from '../titles'
import { assessPacing, type LinkedInActionType, ACTION_LABEL } from './policy'
import type { Task } from '@prisma/client'

/**
 * The LinkedIn queue.
 *
 * The rep works through cards; each card carries the profile link and a drafted
 * message, and the rep clicks Send in their own browser. Nothing here touches
 * LinkedIn — see `policy.ts`.
 *
 * Because the send happens outside the app, the queue cannot observe the outcome.
 * That has one important consequence: **a card is only marked done when the rep
 * says so.** Optimistically completing on click would silently lose actions
 * whenever a request failed, a profile was already connected, or the rep changed
 * their mind mid-flight — and the rep would never know which.
 */

export type QueueCard = {
  taskId: string
  contactId: string
  action: LinkedInActionType
  name: string
  title: string | null
  company: string | null
  profileUrl: string | null
  score: number
  draft: Draft
  checks: DraftCheck[]
  /** Why this person is in the queue at all, shown on the card. */
  rationale: string[]
}

const ACTION_FOR_STEP: Record<string, LinkedInActionType> = {
  linkedin_connect: 'connect',
  linkedin_message: 'message',
  linkedin_view: 'view',
}

function actionFor(payload: unknown): LinkedInActionType {
  const stepType = (payload as { stepType?: string } | null)?.stepType
  return (stepType && ACTION_FOR_STEP[stepType]) || 'connect'
}

/**
 * Builds the queue for a user. Ordered by contact score, because the whole point
 * of a capped daily allowance is that it goes to the best-fit people first.
 */
export async function buildQueue(opts: {
  userId: string
  senderFirstName?: string | null
  limit?: number
}): Promise<{ cards: QueueCard[]; pacing: Record<LinkedInActionType, ReturnType<typeof assessPacing>> }> {
  const { userId, senderFirstName, limit = 60 } = opts

  const tasks = await db().task.findMany({
    where: { type: 'linkedin', status: 'open', assigneeId: userId },
    include: {
      contact: {
        include: { account: true },
      },
    },
    take: limit,
  })

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const completedToday = await db().task.findMany({
    where: {
      type: 'linkedin',
      assigneeId: userId,
      status: 'completed',
      completedAt: { gte: startOfDay },
    },
    select: { payload: true },
  })

  const doneByAction: Record<LinkedInActionType, number> = { connect: 0, message: 0, view: 0 }
  for (const t of completedToday) doneByAction[actionFor(t.payload)]++

  const cards: QueueCard[] = []

  for (const task of tasks) {
    const contact = task.contact
    if (!contact) continue

    const action = actionFor(task.payload)

    const ctx: DraftContext = {
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title,
      company: contact.account?.name ?? null,
      industry: contact.account?.industry ?? null,
      employeeCount: contact.account?.employeeCount ?? null,
      city: contact.city,
      country: contact.country,
      emailedAlready: contact.lastContactedAt != null,
      repliedAlready: contact.lastRepliedAt != null,
      senderFirstName: senderFirstName ?? null,
      seed: contact.id,
      hasProfileUrl: contact.linkedinUrl != null && contact.linkedinUrl.trim() !== '',
    }

    // A draft stored on the task (written by the sequence engine) wins, so a rep
    // editing a card is not silently overwritten on reload.
    const stored = (task.payload as { draft?: string } | null)?.draft
    const draft: Draft = stored
      ? { ...draftMessage(ctx, action), text: stored }
      : draftMessage(ctx, action)

    cards.push({
      taskId: task.id,
      contactId: contact.id,
      action,
      name:
        [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
        contact.email ||
        'Unknown',
      title: contact.title,
      company: contact.account?.name ?? null,
      profileUrl: contact.linkedinUrl,
      score: contact.score,
      draft,
      checks: checkDraft(draft, ctx),
      rationale: rationaleFor(contact, ctx),
    })
  }

  cards.sort((a, b) => b.score - a.score)
  flagDuplicateDrafts(cards)

  return {
    cards,
    pacing: {
      connect: assessPacing('connect', doneByAction.connect),
      message: assessPacing('message', doneByAction.message),
      view: assessPacing('view', doneByAction.view),
    },
  }
}

/**
 * Warns when the same note appears on more than one card.
 *
 * Phrasing variants make this rare, but two people with the same title at the same
 * size of company in the same city can still collide. It matters because sending
 * the identical note repeatedly is the single most recognisable automation tell —
 * to the recipients and to LinkedIn — and the rep is the only one positioned to
 * notice, since they see the whole queue and the drafter sees one card at a time.
 *
 * Only a warning: two identical notes to two people who genuinely have nothing
 * distinguishing them is a defensible thing to send. Twenty is not, and the count
 * is in the message so the rep can tell those apart.
 */
function flagDuplicateDrafts(cards: QueueCard[]): void {
  const groups = new Map<string, QueueCard[]>()
  for (const c of cards) {
    // Compare the message only. The signature line is the same on every card by
    // definition, and leaving it in would not change the grouping — but the
    // greeting would, and "Hi Ada"/"Hi Bo" differing is not personalisation.
    const key = `${c.action}:${c.draft.text.replace(/^Hi[^—]*—\s*/i, '').trim().toLowerCase()}`
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const c of group) {
      c.checks.push({
        severity: 'warning',
        message:
          `This note is identical to ${group.length - 1} other card${group.length > 2 ? 's' : ''} ` +
          `in your queue. Edit it, or enrich the record so the draft has something specific to use.`,
      })
    }
  }
}

function rationaleFor(
  contact: { score: number; status: string; lastRepliedAt: Date | null; lastContactedAt: Date | null },
  ctx: DraftContext
): string[] {
  const out: string[] = []
  if (contact.lastRepliedAt) out.push('Replied to an email')
  else if (contact.lastContactedAt) out.push('Already emailed, no reply yet')
  if (contact.score >= 60) out.push(`Score ${contact.score} — strong fit`)
  else if (contact.score >= 30) out.push(`Score ${contact.score}`)
  if (ctx.title && SENIOR_TITLE.test(ctx.title)) {
    out.push('Senior title')
  }
  if (ctx.employeeCount != null && ctx.employeeCount >= 50 && ctx.employeeCount <= 5000) {
    out.push('Company in target size range')
  }
  return out
}

/**
 * Records that the rep performed the action themselves.
 *
 * `sent` is the rep's assertion, not an observation — the app cannot see
 * LinkedIn. Recorded as such on the timeline so nobody later mistakes it for a
 * confirmed delivery.
 */
export async function recordAction(opts: {
  taskId: string
  actorId: string
  outcome: 'sent' | 'skipped' | 'already_connected' | 'not_a_fit'
  note?: string
  finalText?: string
}): Promise<Task> {
  const { taskId, actorId, outcome, note, finalText } = opts

  const task = await db().task.findUniqueOrThrow({ where: { id: taskId } })
  const action = actionFor(task.payload)

  const updated = await db().task.update({
    where: { id: taskId },
    data: {
      status: outcome === 'sent' ? 'completed' : 'skipped',
      completedAt: new Date(),
      outcome,
      payload: {
        ...((task.payload ?? {}) as object),
        ...(finalText ? { sentText: finalText } : {}),
        recordedBy: 'rep',
      } as never,
      note: note ? `${task.note ? `${task.note}\n\n` : ''}${note}` : task.note,
    },
  })

  if (task.contactId) {
    await db().activity.create({
      data: {
        tenantId: tid(),
        type: 'note',
        summary:
          outcome === 'sent'
            ? `LinkedIn ${ACTION_LABEL[action].replace(/s$/, '')} sent by the rep`
            : `LinkedIn card ${outcome.replace(/_/g, ' ')}`,
        detail: { action, outcome, text: finalText ?? null, source: 'human-in-the-loop' },
        contactId: task.contactId,
        accountId: task.accountId,
        actorId,
      },
    })

    // "Already connected" is real information about the relationship, not a skip.
    if (outcome === 'already_connected') {
      await db().contact.update({
        where: { id: task.contactId },
        data: { status: 'engaged' },
      })
    }
    if (outcome === 'not_a_fit') {
      await db().contact.update({
        where: { id: task.contactId },
        data: { status: 'unqualified' },
      })
      await db().sequenceEnrollment.updateMany({
        where: { contactId: task.contactId, status: 'active' },
        data: {
          status: 'stopped_manual',
          stoppedAt: new Date(),
          stopReason: 'Marked not a fit from the LinkedIn queue',
          nextRunAt: null,
        },
      })
    }

    // A sent connection request earns a follow-up: the value is in the message
    // after acceptance, and that is the step teams forget.
    if (outcome === 'sent' && action === 'connect') {
      await db().task.create({
        data: {
          tenantId: tid(),
          type: 'linkedin',
          title: `Follow up if ${task.title.replace(/^.*?—\s*/, '') || 'they'} accepted`,
          contactId: task.contactId,
          accountId: task.accountId,
          assigneeId: task.assigneeId,
          dueAt: new Date(Date.now() + 4 * 86_400_000),
          priority: 1,
          payload: { stepType: 'linkedin_message' } as never,
        },
      })
    }
  }

  return updated
}

/**
 * Creates queue cards for a set of contacts. Used by the "build a target list"
 * flow as well as by sequence LinkedIn steps.
 */
export async function enqueueContacts(opts: {
  contactIds: string[]
  assigneeId: string
  action?: LinkedInActionType
}): Promise<{ queued: number; skipped: number }> {
  const { contactIds, assigneeId, action = 'connect' } = opts
  const stepType = action === 'message' ? 'linkedin_message' : action === 'view' ? 'linkedin_view' : 'linkedin_connect'

  const contacts = await db().contact.findMany({
    where: {
      id: { in: contactIds },
      linkedinUrl: { not: null },
      status: { notIn: ['do_not_contact', 'unqualified'] },
    },
    select: { id: true, firstName: true, lastName: true, accountId: true },
  })

  let queued = 0
  let skipped = contactIds.length - contacts.length

  for (const c of contacts) {
    // One open card per contact per action — a rep should never see the same
    // person twice in one day's queue.
    const existing = await db().task.findFirst({
      where: { type: 'linkedin', status: 'open', contactId: c.id, assigneeId },
    })
    if (existing) {
      skipped++
      continue
    }

    await db().task.create({
      data: {
        tenantId: tid(),
        type: 'linkedin',
        title: `LinkedIn ${action} — ${[c.firstName, c.lastName].filter(Boolean).join(' ') || 'contact'}`,
        contactId: c.id,
        accountId: c.accountId,
        assigneeId,
        dueAt: new Date(),
        priority: 1,
        payload: { stepType } as never,
      },
    })
    queued++
  }

  return { queued, skipped }
}
