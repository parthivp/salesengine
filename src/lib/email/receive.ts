import { withTenant, db, tid, prismaAdmin } from '../db'
import { classifyReply, detectBulkMail, INTENT_LABEL, type ReplyClassification } from './classify'
import { normalizeEmail, domainFromEmail } from '../utils'
import { rescoreContact } from '../leads/scoring'
import { logger } from '../logger'
import { detectAcceptance, recordAcceptance } from '../linkedin/acceptance'

/**
 * Inbound mail ingestion, provider-agnostic.
 *
 * Everything that fetches mail — IMAP polling, an SES inbound webhook, a Gmail
 * push notification — normalises into `InboundMessage` and calls `ingestInbound`.
 * The transport differs; what to *do* with a reply does not, and having one answer
 * to that is the point of this module.
 *
 * The engine already stops a sequence on reply. What was missing was anything that
 * ever noticed a reply had arrived: `recordReply` existed and was tested, and no
 * production code path called it. So a sequence would keep emailing someone who
 * had already written back — the worst failure this system can have, because it is
 * both damaging and invisible.
 */

export type InboundMessage = {
  /** RFC 5322 Message-ID of the inbound mail. The dedupe key. */
  messageId: string
  inReplyTo?: string | null
  /** References chain, oldest first. */
  references?: string[]
  fromEmail: string
  toEmail: string
  subject: string
  bodyText: string
  bodyHtml?: string | null
  receivedAt: Date
  /** Lowercased header map — the classifier needs these for machine-mail detection. */
  headers?: Record<string, string>
}

export type IngestResult =
  | { ok: false; reason: 'duplicate' | 'no_contact' | 'no_tenant' | 'bulk'; messageId: string }
  | {
      ok: true
      kind?: 'reply'
      messageId: string
      contactId: string
      classification: ReplyClassification
      actions: string[]
    }
  // A LinkedIn notification is not a reply and has no contact of its own — it is
  // mail *about* contacts. Kept as its own variant rather than squeezed into the
  // reply shape, so nothing downstream reads a classification that was never made.
  | {
      ok: true
      kind: 'linkedin_acceptance'
      messageId: string
      matched: number
      alreadyKnown: number
      unmatched: string[]
    }

/**
 * Narrows to the reply case.
 *
 * Worth a helper rather than repeating the discriminant: adding the acceptance
 * variant made every existing caller a type error, which is the compiler correctly
 * pointing out that "we ingested something" no longer implies "we ingested a reply
 * from a prospect".
 */
export function isReply(
  r: IngestResult
): r is Extract<IngestResult, { classification: ReplyClassification }> {
  return r.ok && r.kind !== 'linkedin_acceptance'
}

/** How far back to look when matching a reply to a contact by address alone. */
const ADDRESS_MATCH_WINDOW_MS = 180 * 86_400_000

/** Strips Re:/Fwd:/AW:/RE[2]: prefixes so a subject can be compared across a thread. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim()
  // Repeatedly, because "Re: Fwd: RE: x" is normal after a few hops.
  for (let i = 0; i < 10; i++) {
    const stripped = s.replace(/^\s*(re|fwd?|aw|antw|sv|vs|rif)\s*(\[\d+\])?\s*:\s*/i, '')
    if (stripped === s) break
    s = stripped
  }
  return s.trim().toLowerCase()
}

/**
 * Finds the outbound message this is a reply to.
 *
 * Ordered by how much the signal can be trusted: In-Reply-To is an explicit
 * statement by the replying client; References is the same but weaker after
 * forwards; the address+subject fallbacks are guesses, and are bounded to a
 * window so an unrelated mail from the same person two years later is not
 * stitched onto a dead thread.
 */
async function findThread(msg: InboundMessage): Promise<{
  parentId: string | null
  contactId: string | null
  threadKey: string | null
  how: string
}> {
  const candidates = [msg.inReplyTo, ...(msg.references ?? []).slice().reverse()].filter(
    (x): x is string => Boolean(x)
  )

  for (const ref of candidates) {
    const parent = await db().emailMessage.findFirst({
      where: { messageId: ref, direction: 'outbound' },
      select: { id: true, contactId: true, threadKey: true, messageId: true },
    })
    if (parent) {
      return {
        parentId: parent.id,
        contactId: parent.contactId,
        threadKey: parent.threadKey ?? parent.messageId ?? ref,
        how: ref === msg.inReplyTo ? 'In-Reply-To' : 'References chain',
      }
    }
  }

  // No header match. Fall back to the sender's address — the common case when a
  // reply comes from a different client, or the thread was forwarded internally
  // and someone new replied.
  const email = normalizeEmail(msg.fromEmail)
  if (!email) return { parentId: null, contactId: null, threadKey: null, how: 'unmatched' }

  const contact = await db().contact.findFirst({ where: { email } })
  if (!contact) return { parentId: null, contactId: null, threadKey: null, how: 'unmatched' }

  const since = new Date(msg.receivedAt.getTime() - ADDRESS_MATCH_WINDOW_MS)
  const subject = normalizeSubject(msg.subject)

  // Prefer an outbound with the same normalised subject; otherwise the most
  // recent outbound to this person.
  const recent = await db().emailMessage.findMany({
    where: { contactId: contact.id, direction: 'outbound', sentAt: { gte: since } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, subject: true, threadKey: true, messageId: true },
    take: 25,
  })

  const bySubject = recent.find((m) => normalizeSubject(m.subject) === subject)
  const parent = bySubject ?? recent[0]

  return {
    parentId: parent?.id ?? null,
    contactId: contact.id,
    threadKey: parent?.threadKey ?? parent?.messageId ?? null,
    how: parent ? (bySubject ? 'sender address + subject' : 'sender address') : 'sender address, no prior send',
  }
}

/**
 * Records an inbound message and applies whatever its classification implies.
 *
 * Idempotent on `messageId`: an IMAP poller that crashes mid-batch, or an SNS
 * delivery retried by AWS, must not stop a sequence twice or file two tasks.
 */
export async function ingestInbound(
  tenantId: string,
  msg: InboundMessage,
  now = new Date()
): Promise<IngestResult> {
  return withTenant(tenantId, async () => {
    const existing = await db().emailMessage.findFirst({
      where: { messageId: msg.messageId },
      select: { id: true },
    })
    if (existing) return { ok: false, reason: 'duplicate', messageId: msg.messageId }

    // Before anything else: LinkedIn's own notifications are not prospect replies.
    // A "X accepted your invitation" mail comes from linkedin.com, threads to
    // nothing, and would otherwise be stored as an unmatched inbound message and
    // read by nobody — while carrying the one fact the LinkedIn queue cannot
    // observe for itself.
    const acceptance = detectAcceptance(msg)
    if (acceptance) {
      const r = await recordAcceptance(acceptance.profiles, msg.receivedAt)
      logger.info(
        { messageId: msg.messageId, ...r, unmatched: r.unmatched.length },
        'linkedin connection acceptance'
      )
      return {
        ok: true,
        kind: 'linkedin_acceptance',
        messageId: msg.messageId,
        matched: r.matched,
        alreadyKnown: r.alreadyKnown,
        unmatched: r.unmatched,
      }
    }

    const thread = await findThread(msg)

    // Mail that was sent to a list rather than written to us. A mailbox receives
    // job alerts, newsletters and notifications, and storing each of them as a
    // reply made the inbox a place where a real reply could not be found.
    //
    // The thread check comes first and is the whole safety of this: a message that
    // answers something we sent, or comes from a known contact, is a reply whatever
    // its headers say. Some corporate mail systems stamp bulk headers on ordinary
    // outbound mail, and hiding a live prospect is a far worse error than showing a
    // newsletter.
    const bulk = detectBulkMail(msg)
    if (bulk.isBulk && !thread.parentId && !thread.contactId) {
      await db().emailMessage.create({
        data: {
          tenantId: tid(),
          direction: 'inbound',
          // Kept, not dropped. It is out of the way rather than gone, because the
          // judgement "this is not for us" is ours and it can be wrong.
          status: 'filtered',
          fromEmail: normalizeEmail(msg.fromEmail) ?? msg.fromEmail,
          toEmail: normalizeEmail(msg.toEmail) ?? msg.toEmail,
          subject: msg.subject.slice(0, 500),
          bodyText: msg.bodyText,
          bodyHtml: msg.bodyHtml ?? null,
          messageId: msg.messageId,
          inReplyTo: msg.inReplyTo ?? null,
          threadKey: thread.threadKey ?? msg.messageId,
          repliedAt: msg.receivedAt,
        },
      })
      logger.info(
        { messageId: msg.messageId, from: msg.fromEmail, reasons: bulk.reasons },
        'inbound mail filed as bulk, not a reply'
      )
      return { ok: false, reason: 'bulk', messageId: msg.messageId }
    }

    const classification = classifyReply(
      {
        subject: msg.subject,
        bodyText: msg.bodyText,
        fromEmail: msg.fromEmail,
        headers: msg.headers,
      },
      now
    )

    const actions: string[] = []

    // Store it either way. A reply we cannot attribute to a contact is still
    // something a human should see — dropping it silently is how a live deal ends
    // up sitting unread in a shared mailbox.
    const stored = await db().emailMessage.create({
      data: {
        tenantId: tid(),
        direction: 'inbound',
        status: 'replied',
        contactId: thread.contactId,
        fromEmail: normalizeEmail(msg.fromEmail) ?? msg.fromEmail,
        toEmail: normalizeEmail(msg.toEmail) ?? msg.toEmail,
        subject: msg.subject.slice(0, 500),
        bodyText: msg.bodyText,
        bodyHtml: msg.bodyHtml ?? null,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo ?? null,
        threadKey: thread.threadKey ?? msg.messageId,
        repliedAt: msg.receivedAt,
      },
    })
    actions.push(`stored (${thread.how})`)

    if (thread.parentId) {
      await db().emailMessage.update({
        where: { id: thread.parentId },
        data: { repliedAt: msg.receivedAt },
      })
    }

    if (!thread.contactId) {
      logger.info(
        { messageId: msg.messageId, from: msg.fromEmail, intent: classification.intent },
        'inbound mail could not be matched to a contact'
      )
      return { ok: false, reason: 'no_contact', messageId: msg.messageId }
    }

    const contactId = thread.contactId
    const contact = await db().contact.findUniqueOrThrow({ where: { id: contactId } })

    // --- suppression ---------------------------------------------------------
    if (classification.suppresses) {
      const email = contact.email
      if (email) {
        await db().suppressionEntry.upsert({
          where: { tenantId_type_value: { tenantId: tid(), type: 'email', value: email } },
          update: { reason: 'unsubscribe' },
          create: { tenantId: tid(), type: 'email', value: email, reason: 'unsubscribe' },
        })
      }
      await db().contact.update({
        where: { id: contactId },
        data: { unsubscribedAt: now, status: 'do_not_contact' },
      })
      actions.push('suppressed')
    }

    if (classification.intent === 'bounce') {
      await db().contact.update({ where: { id: contactId }, data: { bouncedAt: now } })
      actions.push('marked bounced')
    }

    // --- sequence -------------------------------------------------------------
    if (classification.stopsSequence) {
      const stopped = await db().sequenceEnrollment.updateMany({
        where: { contactId, status: 'active' },
        data: {
          status: classification.suppresses ? 'stopped_unsubscribed' : 'stopped_replied',
          stoppedAt: now,
          stopReason: `Reply classified as: ${INTENT_LABEL[classification.intent]}`,
          nextRunAt: null,
        },
      })
      if (stopped.count) actions.push(`stopped ${stopped.count} enrollment(s)`)
    } else if (classification.intent === 'out_of_office' && classification.returnsAt) {
      // The payoff for classifying rather than blanket-stopping: hold the sequence
      // until they are back, instead of either emailing an empty desk for a
      // fortnight or losing them entirely.
      const held = await db().sequenceEnrollment.updateMany({
        where: { contactId, status: 'active', nextRunAt: { lt: classification.returnsAt } },
        data: { nextRunAt: classification.returnsAt },
      })
      if (held.count) {
        actions.push(`held ${held.count} enrollment(s) until ${classification.returnsAt.toISOString().slice(0, 10)}`)
      }
    }

    // --- contact state --------------------------------------------------------
    const humanReply = !['out_of_office', 'auto_reply', 'bounce'].includes(classification.intent)
    if (humanReply) {
      await db().contact.update({
        where: { id: contactId },
        data: {
          lastRepliedAt: now,
          // A decline is still engagement — they are a real person who read it —
          // but it must not look like an opportunity on the board.
          status: classification.suppresses
            ? 'do_not_contact'
            : classification.intent === 'not_interested'
              ? 'unqualified'
              : 'engaged',
        },
      })
    }

    // --- timeline -------------------------------------------------------------
    await db().activity.create({
      data: {
        tenantId: tid(),
        type: 'reply',
        summary: `${INTENT_LABEL[classification.intent]}: ${msg.subject}`.slice(0, 200),
        detail: {
          intent: classification.intent,
          confidence: classification.confidence,
          reasons: classification.reasons,
          needsReview: classification.needsReview,
          messageId: stored.id,
        },
        contactId,
        accountId: contact.accountId,
        occurredAt: msg.receivedAt,
      },
    })

    // --- task -----------------------------------------------------------------
    const task = taskFor(classification)
    if (task && contact.ownerId) {
      await db().task.create({
        data: {
          tenantId: tid(),
          type: task.type,
          title: `${task.title} — ${contact.firstName ?? contact.email ?? 'contact'}`,
          note: msg.bodyText.slice(0, 500),
          contactId,
          accountId: contact.accountId,
          assigneeId: contact.ownerId,
          dueAt: now,
          priority: task.priority,
        },
      })
      actions.push(`task: ${task.title}`)
    }

    if (humanReply) await rescoreContact(contactId)

    logger.info(
      { messageId: msg.messageId, contactId, intent: classification.intent, actions },
      'inbound reply ingested'
    )

    return { ok: true, messageId: msg.messageId, contactId, classification, actions }
  })
}

/**
 * Which replies deserve a human's attention, and how urgently.
 *
 * An automated absence notice does not — filing a task for every out-of-office is
 * how a task list becomes noise that nobody reads, which costs more than the
 * feature is worth.
 */
function taskFor(
  c: ReplyClassification
): { type: 'follow_up' | 'call'; title: string; priority: number } | null {
  switch (c.intent) {
    case 'interested':
      return { type: 'follow_up', title: 'Interested — reply today', priority: 3 }
    case 'wrong_person':
      return { type: 'follow_up', title: 'Referred elsewhere — find the right person', priority: 2 }
    case 'unclear':
      return { type: 'follow_up', title: 'Reply needs a read', priority: 2 }
    case 'not_interested':
      // No task: the sequence is stopped and the contact is marked. There is
      // nothing for a person to do, and a task would only be closed unread.
      return null
    case 'unsubscribe':
    case 'out_of_office':
    case 'auto_reply':
    case 'bounce':
      return null
  }
}

/**
 * Resolves which tenant an inbound message belongs to, by the address it was sent
 * to. Runs outside tenant context by necessity — the whole question is which
 * tenant this is — so it reads only the mailbox table via the admin client.
 */
export async function tenantForInbound(toEmail: string): Promise<string | null> {
  const email = normalizeEmail(toEmail)
  if (!email) return null

  const mailbox = await prismaAdmin.mailbox.findFirst({
    where: { email },
    select: { tenantId: true },
  })
  if (mailbox) return mailbox.tenantId

  // A plus-addressed or subdomain-routed reply address, e.g. reply+abc@mail.acme.io
  const domain = domainFromEmail(email)
  if (!domain) return null
  const byDomain = await prismaAdmin.mailbox.findFirst({
    where: { email: { endsWith: `@${domain}` } },
    select: { tenantId: true },
  })
  return byDomain?.tenantId ?? null
}
