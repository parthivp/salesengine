import { withTenant, db, tid, prismaAdmin } from '../../lib/db'
import { logger } from '../../lib/logger'
import { enqueue } from '../../lib/queue'
import type { StepCondition } from '../../lib/sequences/conditions'
import { domainFromEmail } from '../../lib/utils'
import { render, valuesFor } from '../../lib/email/merge'
import {
  computeNextRunAt, windowFromSequence, pickMailbox, type MailboxCapacity,
} from '../../lib/email/schedule'
import {
  transportFor, newMessageId, unsubscribeUrl, appendTrackingPixel,
  rewriteLinksForTracking, textToHtml, type OutboundEmail,
} from '../../lib/email/send'
import { ingestInbound, isReply } from '../../lib/email/receive'
import { checkEmailQuota, recordEmailSent } from '../../lib/limits'
import type { EnrollmentStatus, SequenceStep } from '@prisma/client'

/**
 * The sequence step machine.
 *
 * Correctness requirements, in the order they bite:
 *
 *  1. **Never double-send.** A retried job, a duplicated tick, or a crash
 *     mid-send must not produce two emails. Achieved with an outbox row written
 *     *before* the provider call, carrying a deterministic idempotency key that
 *     is unique in the database.
 *  2. **Never send after a reply.** Reply/bounce/unsubscribe set the enrollment
 *     to stopped; the step re-reads status inside the same transaction that
 *     claims the lock, so a reply landing mid-flight wins.
 *  3. **Never hold a transaction open across HTTP.** The provider call sits
 *     between two short transactions. A long interactive transaction pinned to
 *     one connection would exhaust the pool under load.
 *
 * The shape is therefore: claim → prepare → (commit) → send → record.
 */

const LOCK_STALE_MS = 5 * 60_000

type PreparedSend = {
  kind: 'send'
  messageRowId: string
  email: OutboundEmail
  provider: string
  mailboxId: string
  contactId: string
  stepId: string
}

/**
 * How long the engine waits for a human to action a card before giving up on the
 * step and moving on.
 *
 * Two weeks: long enough to cover a holiday, short enough that a campaign someone
 * abandoned does not sit "in progress" for a quarter. Timing out advances rather
 * than stops, because the person is still a live prospect — it is the *step* that
 * was skipped, not the relationship.
 */
const HUMAN_STEP_PATIENCE_MS = 14 * 86_400_000

type PreparedOutcome =
  | PreparedSend
  | { kind: 'skip'; reason: string }
  | { kind: 'stop'; status: EnrollmentStatus; reason: string }
  | { kind: 'defer'; until: Date; reason: string }
  | { kind: 'advanced' }
  | { kind: 'completed' }
  /** Parked on a card a human has to action before the campaign continues. */
  | { kind: 'waiting' }

export async function processEnrollmentStep({
  enrollmentId,
  tenantId,
}: {
  enrollmentId: string
  tenantId: string
}) {
  const log = logger.child({ enrollmentId, tenantId })

  // --- phase 1: claim and prepare (short transaction) ----------------------
  const prepared = await withTenant(tenantId, () => claimAndPrepare(enrollmentId, log))

  if (prepared.kind !== 'send') {
    log.debug({ outcome: prepared.kind }, 'step resolved without sending')
    return prepared
  }

  // --- phase 2: the provider call, deliberately outside any transaction ----
  const transport = transportFor(prepared.provider)
  const outcome = await transport.send(prepared.email)

  // --- phase 3: record the result (short transaction) ----------------------
  return withTenant(tenantId, async () => {
    if (outcome.ok) {
      await db().emailMessage.update({
        where: { id: prepared.messageRowId },
        data: {
          status: 'sent',
          sentAt: new Date(),
          providerId: outcome.providerId,
        },
      })

      await db().mailbox.update({
        where: { id: prepared.mailboxId },
        data: { sentToday: { increment: 1 }, sentTodayOn: new Date() },
      })

      await db().contact.update({
        where: { id: prepared.contactId },
        data: { lastContactedAt: new Date(), status: 'working' },
      })

      await db().activity.create({
        data: {
          tenantId: tid(),
          type: 'email_sent',
          summary: `Sent: ${prepared.email.subject}`,
          contactId: prepared.contactId,
          detail: { messageId: prepared.messageRowId, stepId: prepared.stepId },
        },
      })

      await advance(enrollmentId)
      await recordEmailSent()
      log.info({ to: prepared.email.to }, 'sequence email sent')
      return { sent: true }
    }

    // Failure. Retryable failures leave the enrollment due again shortly;
    // permanent ones stop it, so we do not grind against a rejected address.
    await db().emailMessage.update({
      where: { id: prepared.messageRowId },
      data: { status: 'failed', failedAt: new Date(), error: outcome.error },
    })

    if (outcome.retryable) {
      await db().sequenceEnrollment.update({
        where: { id: enrollmentId },
        data: {
          lockedAt: null,
          lockedBy: null,
          attempts: { increment: 1 },
          lastError: outcome.error,
          nextRunAt: new Date(Date.now() + 15 * 60_000),
        },
      })
      log.warn({ error: outcome.error }, 'send failed, will retry')
      return { sent: false, retrying: true }
    }

    await db().sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: 'failed',
        lockedAt: null,
        lockedBy: null,
        lastError: outcome.error,
        nextRunAt: null,
        stoppedAt: new Date(),
        stopReason: outcome.error,
      },
    })
    log.error({ error: outcome.error }, 'send failed permanently, enrollment stopped')
    return { sent: false, retrying: false }
  })
}

// ---------------------------------------------------------------------------

type Log = Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error'>

async function claimAndPrepare(
  enrollmentId: string,
  log: Log
): Promise<PreparedOutcome> {
  const enrollment = await db().sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      sequence: { include: { steps: { orderBy: { order: 'asc' } } } },
      contact: { include: { account: true } },
    },
  })

  if (!enrollment) return { kind: 'skip', reason: 'enrollment_missing' }
  if (enrollment.status !== 'active') return { kind: 'skip', reason: `status_${enrollment.status}` }
  if (enrollment.sequence.status !== 'active') {
    return { kind: 'defer', until: new Date(Date.now() + 3_600_000), reason: 'sequence_not_active' }
  }

  // Lock: a stale lock is reclaimable so a crashed worker cannot wedge an
  // enrollment forever, but a fresh one means another worker holds it.
  if (enrollment.lockedAt && Date.now() - enrollment.lockedAt.getTime() < LOCK_STALE_MS) {
    return { kind: 'skip', reason: 'locked_elsewhere' }
  }

  const claim = await db().sequenceEnrollment.updateMany({
    where: {
      id: enrollmentId,
      status: 'active',
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } }],
    },
    data: { lockedAt: new Date(), lockedBy: `worker:${process.pid}` },
  })
  if (claim.count === 0) return { kind: 'skip', reason: 'lost_lock_race' }

  const { contact, sequence } = enrollment

  // --- hard stops, whatever the channel ------------------------------------
  //
  // Only the ones that mean "do not contact this person at all". The email-shaped
  // checks moved down to the email branch: they used to run here, and
  // `!contact.email` failed the enrollment outright — which made a LinkedIn-only
  // campaign impossible, since a Sales Navigator list has no email addresses by
  // definition. The campaign died on its first tick with "Contact has no email
  // address" against someone we never intended to email.
  if (contact.unsubscribedAt) {
    return stop(enrollmentId, 'stopped_unsubscribed', 'Contact unsubscribed')
  }
  if (contact.status === 'do_not_contact') {
    return stop(enrollmentId, 'stopped_manual', 'Contact marked do-not-contact')
  }

  if (sequence.stopOnReply && contact.lastRepliedAt) {
    return stop(enrollmentId, 'stopped_replied', 'Contact replied')
  }

  // Account-level reply: if a colleague already answered, continuing to email
  // this person makes the whole team look uncoordinated.
  if (sequence.stopOnAccountReply && contact.accountId) {
    const colleagueReplied = await db().contact.findFirst({
      where: {
        accountId: contact.accountId,
        id: { not: contact.id },
        lastRepliedAt: { not: null },
      },
      select: { id: true },
    })
    if (colleagueReplied) {
      return stop(enrollmentId, 'stopped_replied', 'Someone else at this account replied')
    }
  }

  // --- which step? --------------------------------------------------------
  const step = selectStep(enrollment.sequence.steps, enrollment.stepIndex, enrollment.id)
  if (!step) {
    await db().sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        nextRunAt: null,
        lockedAt: null,
        lockedBy: null,
      },
    })
    return { kind: 'completed' }
  }

  const window = windowFromSequence(sequence, contact.timezone ?? 'Asia/Kolkata')

  // --- conditions ---------------------------------------------------------
  const conditionResult = await evaluateConditions(step, contact.id)
  if (!conditionResult.pass) {
    log.debug({ stepId: step.id, reason: conditionResult.reason }, 'condition not met; skipping step')
    await advance(enrollmentId, window)
    return { kind: 'advanced' }
  }

  // --- non-email steps ----------------------------------------------------
  if (step.type === 'wait') {
    await advance(enrollmentId, window)
    return { kind: 'advanced' }
  }

  if (step.type === 'task' || step.type === 'call' || step.type.startsWith('linkedin')) {
    const who =
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
      contact.email ||
      'this contact'

    await db().task.create({
      data: {
        tenantId: tid(),
        type:
          step.type === 'call' ? 'call'
          : step.type.startsWith('linkedin') ? 'linkedin'
          : 'follow_up',
        // Falling back to the email address produced "linkedin connect — null" on
        // every LinkedIn-only contact, which is most of them: these lists have no
        // email, which is the entire reason the LinkedIn path exists.
        title: step.taskNote?.slice(0, 200) ?? `${step.type.replace(/_/g, ' ')} — ${who}`,
        note: step.taskNote,
        contactId: contact.id,
        accountId: contact.accountId,
        assigneeId: contact.ownerId,
        dueAt: new Date(),
        enrollmentId,
        // The drafted message the rep will send themselves. This is the
        // human-in-the-loop LinkedIn path — we never touch LinkedIn ourselves.
        payload: step.type.startsWith('linkedin')
          ? {
              linkedinUrl: contact.linkedinUrl,
              draft: render(step.bodyText ?? '', valuesFor(contact, { name: null, email: null })).text,
              stepType: step.type,
            }
          : {},
      },
    })

    // Stop here. The step is not done until a human does it.
    //
    // This used to advance immediately, which meant a campaign of
    // "connect → wait 2 days → message" queued the message card whether or not
    // the connection request was ever sent, and whether or not it was accepted.
    // The campaign looked like it was running while describing something that had
    // not happened — worse than not running at all, because the numbers lied.
    //
    // `waitingUntil` is the escape hatch: an enrollment blocked on a card nobody
    // ever actions would otherwise sit there forever, and a stalled campaign that
    // still reads as active is exactly the invisible failure this engine keeps
    // trying to avoid.
    await db().sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: 'waiting_on_human',
        nextRunAt: null,
        waitingUntil: new Date(Date.now() + HUMAN_STEP_PATIENCE_MS),
      },
    })
    return { kind: 'waiting' }
  }

  if (step.type !== 'email') {
    await advance(enrollmentId, window)
    return { kind: 'advanced' }
  }

  // --- email-only preconditions -------------------------------------------
  //
  // A bounced address, a missing address and a suppression entry are all facts
  // about *email*. None of them says anything about whether this person can be
  // approached on LinkedIn, so they gate the email step rather than the
  // enrollment. A mixed campaign skips the email and carries on.
  if (!contact.email) {
    log.info({ contactId: contact.id }, 'skipping email step: contact has no email address')
    await advance(enrollmentId, window)
    return { kind: 'advanced' }
  }
  if (contact.bouncedAt) {
    return stop(enrollmentId, 'stopped_bounced', 'Previous email bounced')
  }

  const domain = domainFromEmail(contact.email)
  const suppressed = await db().suppressionEntry.findFirst({
    where: {
      OR: [
        { type: 'email', value: contact.email },
        ...(domain ? [{ type: 'domain' as const, value: domain }] : []),
      ],
    },
    select: { reason: true },
  })
  if (suppressed) {
    return stop(enrollmentId, 'stopped_unsubscribed', `Suppressed (${suppressed.reason})`)
  }

  // --- mailbox capacity ---------------------------------------------------
  const mailboxes = await db().mailbox.findMany({
    where: { health: { in: ['healthy', 'warming'] } },
  })
  if (!mailboxes.length) {
    // No mailbox connected yet. Defer rather than fail — the enrollment should
    // resume by itself once an admin connects one.
    return deferEnrollment(
      enrollmentId,
      new Date(Date.now() + 3_600_000),
      'No sending mailbox available'
    )
  }

  const preferred = enrollment.mailboxId
    ? mailboxes.filter((m) => m.id === enrollment.mailboxId)
    : mailboxes
  const chosen =
    pickMailbox(preferred as unknown as MailboxCapacity[]) ??
    pickMailbox(mailboxes as unknown as MailboxCapacity[])

  if (!chosen) {
    // Every mailbox is capped for today — try again at the next window opening
    // rather than sending over the cap.
    const retryAt = computeNextRunAt({ delayMinutes: 60, window })
    return deferEnrollment(enrollmentId, retryAt, 'All mailboxes at their daily cap')
  }

  const mailbox = mailboxes.find((m) => m.id === chosen.id)!

  // --- render -------------------------------------------------------------
  const owner = contact.ownerId
    ? await db().user.findUnique({
        where: { id: contact.ownerId },
        select: { name: true, email: true },
      })
    : null

  const sender = { name: owner?.name ?? mailbox.fromName, email: mailbox.email }
  const values = valuesFor(contact, sender)

  const template = step.templateId
    ? await db().emailTemplate.findUnique({ where: { id: step.templateId } })
    : null

  const rawSubject = step.subject ?? template?.subject ?? ''
  const rawText = step.bodyText ?? template?.bodyText ?? ''

  const subject = render(rawSubject, values)
  const text = render(rawText, values)

  // An unresolved tag must never reach a prospect. Failing the step is the
  // right outcome: the rep fixes the template, or adds a fallback.
  const unresolved = [...new Set([...subject.unresolved, ...text.unresolved])]
  if (unresolved.length) {
    return stop(
      enrollmentId,
      'failed',
      `Unresolved merge tags: ${unresolved.join(', ')}. Add a fallback like {{first_name | there}}.`
    )
  }

  // --- outbox row, written BEFORE the provider call -----------------------
  // The unique idempotency key is what makes a retry safe: a second attempt
  // collides on the unique index instead of sending again.
  const idempotencyKey = `${enrollment.id}:${step.id}:${enrollment.stepIndex}`

  const already = await db().emailMessage.findFirst({
    where: { idempotencyKey },
    select: { id: true, status: true },
  })
  if (already && already.status !== 'failed') {
    log.warn({ idempotencyKey, status: already.status }, 'step already has an outbox row; advancing')
    await advance(enrollmentId, window)
    return { kind: 'skip', reason: 'already_sent' }
  }

  // The monthly quota, checked before anything is written to the outbox.
  //
  // This was the gap: `monthlyEmailLimit` existed on the tenant, was shown in the
  // UI, and bounded nothing — a runaway sequence could send without limit while
  // the operator believed a cap was in force. Deferred rather than stopped, so
  // enrollments resume next month instead of needing to be rebuilt by hand.
  const quota = await checkEmailQuota()
  if (!quota.allowed) {
    log.warn({ used: quota.used, limit: quota.limit }, 'monthly email limit reached; deferring')
    return deferEnrollment(enrollmentId, startOfNextMonth(), 'monthly_email_limit')
  }

  const sendingDomain = domainFromEmail(mailbox.email) ?? 'localhost'
  const rfcMessageId = newMessageId(sendingDomain)

  const messageRow = await db().emailMessage.create({
    data: {
      tenantId: tid(),
      direction: 'outbound',
      status: 'queued',
      contactId: contact.id,
      mailboxId: mailbox.id,
      enrollmentId: enrollment.id,
      fromEmail: mailbox.email,
      toEmail: contact.email,
      subject: subject.text,
      bodyText: text.text,
      messageId: rfcMessageId,
      threadKey: `${sequence.id}:${contact.id}`,
      idempotencyKey: already ? `${idempotencyKey}:retry:${Date.now()}` : idempotencyKey,
      scheduledAt: new Date(),
    },
  })

  const unsubUrl = unsubscribeUrl(messageRow.id)
  let html = textToHtml(text.text, unsubUrl)
  if (sequence.trackClicks) html = rewriteLinksForTracking(html, messageRow.id)
  if (sequence.trackOpens) html = appendTrackingPixel(html, messageRow.id)

  // The stored copy must be byte-identical to what leaves the building. An
  // archive that omits the unsubscribe footer cannot answer "what exactly did we
  // send this person?", which is the only question that matters in a complaint.
  const finalText = `${text.text}\n\n—\nUnsubscribe: ${unsubUrl}`

  await db().emailMessage.update({
    where: { id: messageRow.id },
    data: { bodyHtml: html, bodyText: finalText },
  })

  return {
    kind: 'send',
    messageRowId: messageRow.id,
    provider: mailbox.provider,
    mailboxId: mailbox.id,
    contactId: contact.id,
    stepId: step.id,
    email: {
      from: { name: sender.name, email: mailbox.email },
      to: contact.email,
      replyTo: owner?.email ?? undefined,
      subject: subject.text,
      html,
      text: finalText,
      listUnsubscribeUrl: unsubUrl,
      idempotencyKey: messageRow.id,
      tags: { sequence: sequence.id.slice(0, 40), step: String(step.order) },
    },
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A/B variants share an order. One is chosen per enrollment, deterministically
 * from the enrollment id so a retry picks the same variant — otherwise a retried
 * step could send variant B after variant A already went out.
 */
function selectStep(
  steps: SequenceStep[],
  index: number,
  enrollmentId: string
): SequenceStep | null {
  const orders = [...new Set(steps.map((s) => s.order))].sort((a, b) => a - b)
  const order = orders[index]
  if (order == null) return null

  const candidates = steps.filter((s) => s.order === order)
  if (candidates.length === 1) return candidates[0]

  const totalWeight = candidates.reduce((n, s) => n + Math.max(1, s.variantWeight), 0)
  let hash = 0
  for (let i = 0; i < enrollmentId.length; i++) {
    hash = (hash * 31 + enrollmentId.charCodeAt(i)) % 100_000
  }
  let target = hash % totalWeight
  for (const c of candidates) {
    target -= Math.max(1, c.variantWeight)
    if (target < 0) return c
  }
  return candidates[0]
}

type Condition = {
  // The vocabulary lives in lib/sequences/conditions.ts so the UI's label map can
  // be typed against it — a condition with no label used to render as no branch
  // at all, which makes a conditional campaign look unconditional.
  type?: StepCondition
  withinDays?: number
}

async function evaluateConditions(
  step: SequenceStep,
  contactId: string
): Promise<{ pass: boolean; reason?: string }> {
  const cond = (step.conditions ?? {}) as Condition
  const type = cond.type ?? 'always'
  if (type === 'always') return { pass: true }

  const since = cond.withinDays
    ? new Date(Date.now() - cond.withinDays * 86_400_000)
    : undefined

  const where = {
    contactId,
    direction: 'outbound' as const,
    ...(since ? { sentAt: { gte: since } } : {}),
  }

  switch (type) {
    case 'if_opened': {
      const n = await db().emailMessage.count({ where: { ...where, opensCount: { gt: 0 } } })
      return n > 0 ? { pass: true } : { pass: false, reason: 'not_opened' }
    }
    case 'if_not_opened': {
      const n = await db().emailMessage.count({ where: { ...where, opensCount: { gt: 0 } } })
      return n === 0 ? { pass: true } : { pass: false, reason: 'was_opened' }
    }
    case 'if_clicked': {
      const n = await db().emailMessage.count({ where: { ...where, clicksCount: { gt: 0 } } })
      return n > 0 ? { pass: true } : { pass: false, reason: 'not_clicked' }
    }
    case 'if_not_clicked': {
      const n = await db().emailMessage.count({ where: { ...where, clicksCount: { gt: 0 } } })
      return n === 0 ? { pass: true } : { pass: false, reason: 'was_clicked' }
    }
    case 'if_no_reply': {
      const n = await db().emailMessage.count({
        where: { contactId, direction: 'inbound', ...(since ? { createdAt: { gte: since } } : {}) },
      })
      return n === 0 ? { pass: true } : { pass: false, reason: 'replied' }
    }
    case 'if_connected': {
      const c = await db().contact.findUnique({
        where: { id: contactId },
        select: { linkedinConnectedAt: true },
      })
      const at = c?.linkedinConnectedAt
      if (!at) return { pass: false, reason: 'not_connected' }
      // `withinDays` here means "accepted recently", which is how you build
      // "message them while it is still warm" without messaging someone who
      // accepted eight months ago and has forgotten who you are.
      if (since && at < since) return { pass: false, reason: 'connected_too_long_ago' }
      return { pass: true }
    }
    case 'if_not_connected': {
      const c = await db().contact.findUnique({
        where: { id: contactId },
        select: { linkedinConnectedAt: true },
      })
      // Deliberately *not* "declined". LinkedIn never reports a decline, so this
      // means "no acceptance seen yet" and nothing more.
      return c?.linkedinConnectedAt ? { pass: false, reason: 'connected' } : { pass: true }
    }
    default:
      return { pass: true }
  }
}

/**
 * Releases an enrollment parked on a human step, once the human has done it.
 *
 * Called from the LinkedIn queue when a card is actioned. Deliberately tolerant:
 * a card with no enrollment (built ad hoc from "build target list" rather than by
 * a campaign) is the common case and is not an error.
 *
 * Must be called inside a tenant context.
 */
export async function releaseHumanStep(
  enrollmentId: string,
  outcome: 'done' | 'abandoned'
): Promise<{ released: boolean }> {
  const enrollment = await db().sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, status: true },
  })
  if (!enrollment || enrollment.status !== 'waiting_on_human') return { released: false }

  await db().sequenceEnrollment.update({
    where: { id: enrollment.id },
    data: { status: 'active', waitingUntil: null },
  })

  if (outcome === 'abandoned') {
    // "Not a fit" and "already connected" end the campaign for this person rather
    // than marching them through the remaining steps. Continuing would be the
    // engine overruling a judgement the operator just made by hand.
    await db().sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: 'stopped_manual',
        stoppedAt: new Date(),
        stopReason: 'Card resolved without sending',
        nextRunAt: null,
      },
    })
    return { released: true }
  }

  await advance(enrollment.id)
  return { released: true }
}

/**
 * Moves on from steps nobody ever actioned.
 *
 * Run from the tick. Without it a campaign parks on a card the operator ignored
 * and stays "in progress" indefinitely — alive on the dashboard, doing nothing.
 */
export async function timeOutAbandonedSteps(): Promise<{ timedOut: number }> {
  const stale = await db().sequenceEnrollment.findMany({
    where: { status: 'waiting_on_human', waitingUntil: { lt: new Date() } },
    select: { id: true },
    take: 500,
  })

  for (const e of stale) {
    await db().sequenceEnrollment.update({
      where: { id: e.id },
      data: { status: 'active', waitingUntil: null },
    })
    // Advance rather than stop: the step was skipped, the prospect is still live.
    await advance(e.id)
  }

  if (stale.length) logger.info({ timedOut: stale.length }, 'human steps timed out')
  return { timedOut: stale.length }
}

async function advance(
  enrollmentId: string,
  window?: ReturnType<typeof windowFromSequence>
): Promise<void> {
  const enrollment = await db().sequenceEnrollment.findUniqueOrThrow({
    where: { id: enrollmentId },
    include: {
      sequence: { include: { steps: { orderBy: { order: 'asc' } } } },
      contact: { select: { timezone: true } },
    },
  })

  const orders = [...new Set(enrollment.sequence.steps.map((s) => s.order))].sort((a, b) => a - b)
  const nextIndex = enrollment.stepIndex + 1
  const nextOrder = orders[nextIndex]

  if (nextOrder == null) {
    await db().sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: 'completed',
        stepIndex: nextIndex,
        completedAt: new Date(),
        nextRunAt: null,
        lockedAt: null,
        lockedBy: null,
        currentStepId: null,
      },
    })
    return
  }

  const nextStep = enrollment.sequence.steps.find((s) => s.order === nextOrder)!
  const win =
    window ??
    windowFromSequence(enrollment.sequence, enrollment.contact.timezone ?? 'Asia/Kolkata')

  const nextRunAt = computeNextRunAt({
    delayMinutes: nextStep.delayMinutes,
    window: win,
    jitterMinutes: 20,
  })

  await db().sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: {
      stepIndex: nextIndex,
      currentStepId: nextStep.id,
      nextRunAt,
      lockedAt: null,
      lockedBy: null,
      attempts: 0,
      lastError: null,
    },
  })
}

async function stop(
  enrollmentId: string,
  status: EnrollmentStatus,
  reason: string
): Promise<PreparedOutcome> {
  await db().sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: {
      status,
      stoppedAt: new Date(),
      stopReason: reason,
      nextRunAt: null,
      lockedAt: null,
      lockedBy: null,
    },
  })
  return { kind: 'stop', status, reason }
}

async function deferEnrollment(
  enrollmentId: string,
  until: Date,
  reason: string
): Promise<PreparedOutcome> {
  await db().sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { nextRunAt: until, lockedAt: null, lockedBy: null, lastError: reason },
  })
  return { kind: 'defer', until, reason }
}

/** First moment of next month, UTC — when a monthly quota resets. */
function startOfNextMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export async function enrollContacts({
  tenantId,
  sequenceId,
  contactIds,
  enrolledById,
}: {
  tenantId: string
  sequenceId: string
  contactIds: string[]
  enrolledById?: string
}) {
  return withTenant(
    tenantId,
    async () => {
      const sequence = await db().sequence.findUniqueOrThrow({
        where: { id: sequenceId },
        include: { steps: { orderBy: { order: 'asc' } } },
      })
      if (!sequence.steps.length) throw new Error('Cannot enrol into a sequence with no steps')

      const orders = [...new Set(sequence.steps.map((s) => s.order))].sort((a, b) => a - b)
      const firstStep = sequence.steps.find((s) => s.order === orders[0])!

      const contacts = await db().contact.findMany({
        where: {
          id: { in: contactIds },
          email: { not: null },
          unsubscribedAt: null,
          bouncedAt: null,
          status: { not: 'do_not_contact' },
        },
        select: { id: true, timezone: true, email: true },
      })

      let enrolled = 0
      let skipped = contactIds.length - contacts.length

      for (const contact of contacts) {
        const existing = await db().sequenceEnrollment.findFirst({
          where: { sequenceId, contactId: contact.id },
          select: { id: true },
        })
        if (existing) {
          skipped++
          continue
        }

        const window = windowFromSequence(sequence, contact.timezone ?? 'Asia/Kolkata')
        await db().sequenceEnrollment.create({
          data: {
            tenantId: tid(),
            sequenceId,
            contactId: contact.id,
            currentStepId: firstStep.id,
            stepIndex: 0,
            status: 'active',
            enrolledById,
            nextRunAt: computeNextRunAt({
              delayMinutes: firstStep.delayMinutes,
              window,
              jitterMinutes: 20,
            }),
          },
        })
        enrolled++
      }

      logger.info({ sequenceId, enrolled, skipped }, 'contacts enrolled')
      return { enrolled, skipped }
    },
    { timeout: 120_000 }
  )
}

/**
 * Records an inbound reply, by way of the ingestion pipeline.
 *
 * Kept as a convenience for callers that already know the contact — a manual
 * "log a reply" action, and the tests below. It used to contain its own logic,
 * and that logic was naive in a way that mattered: it stopped the sequence,
 * marked the contact engaged and filed a task for *every* inbound message. An
 * out-of-office would end the sequence; an unsubscribe request would not
 * suppress. Both are silent failures.
 *
 * So it now delegates to `ingestInbound`, which classifies first. There is one
 * decision about what a reply means, and it lives in `email/classify.ts`.
 */
export async function recordReply({
  tenantId,
  contactId,
  subject,
  bodyText,
  messageId,
  inReplyTo,
}: {
  tenantId: string
  contactId: string
  subject: string
  bodyText: string
  messageId?: string
  inReplyTo?: string
}) {
  const contact = await withTenant(tenantId, () =>
    db().contact.findUniqueOrThrow({ where: { id: contactId } })
  )

  const result = await ingestInbound(tenantId, {
    messageId: messageId ?? `<manual-${contactId}-${Date.now()}@salesengine.local>`,
    inReplyTo: inReplyTo ?? null,
    fromEmail: contact.email ?? `unknown-${contactId}@invalid.local`,
    toEmail: '',
    subject,
    bodyText,
    receivedAt: new Date(),
  })

  return {
    stoppedEnrollments: isReply(result)
      ? Number(/stopped (\d+) enrollment/.exec(result.actions.join(' '))?.[1] ?? 0)
      : 0,
  }
}

/** Fans out due enrollments. Kept here so the tick and the machine live together. */
export async function sequenceTick() {
  // Sweep abandoned human steps first, so anything that timed out this minute is
  // active again and picked up by the same pass rather than the next one.
  const stalled = await prismaAdmin.sequenceEnrollment.findMany({
    where: { status: 'waiting_on_human', waitingUntil: { lt: new Date() } },
    select: { tenantId: true },
    distinct: ['tenantId'],
    take: 200,
  })
  for (const { tenantId } of stalled) {
    await withTenant(tenantId, () => timeOutAbandonedSteps())
  }

  const due = await prismaAdmin.sequenceEnrollment.findMany({
    where: {
      status: 'active',
      nextRunAt: { lte: new Date() },
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } }],
    },
    select: { id: true, tenantId: true },
    take: 1000,
    orderBy: { nextRunAt: 'asc' },
  })

  for (const e of due) {
    await enqueue(
      'sequence:step',
      { enrollmentId: e.id, tenantId: e.tenantId },
      { jobId: `step:${e.id}:${Math.floor(Date.now() / 60_000)}` }
    )
  }

  if (due.length) logger.info({ count: due.length }, 'sequence tick fanned out')
  return { dispatched: due.length }
}
