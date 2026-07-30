'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { INTENT_LABEL, type ReplyIntent } from '@/lib/email/classify'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'

/**
 * Inbox triage.
 *
 * The classifier is heuristic, so a person has to be able to overrule it — and
 * when they do, the correction is recorded on the timeline rather than silently
 * mutating the original call. What the machine thought and what the human decided
 * are different facts, and a system that overwrites the first with the second
 * cannot be evaluated later.
 */

const schema = z.object({
  messageId: z.string().min(1),
  intent: z.enum([
    'interested', 'not_interested', 'unsubscribe', 'wrong_person',
    'out_of_office', 'auto_reply', 'bounce', 'unclear',
  ]),
})

export type TriageResult = { ok: true; actions: string[] } | { ok: false; error: string }

export async function reclassify(input: z.infer<typeof schema>): Promise<TriageResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid request.' }
  const { messageId, intent } = parsed.data

  const auth = await requirePermission('contact:update')

  try {
    return await withTenant(auth.tenant.id, async () => {
      const message = await db().emailMessage.findUnique({
        where: { id: messageId },
        select: { id: true, contactId: true, subject: true, direction: true },
      })
      if (!message || message.direction !== 'inbound') {
        return { ok: false as const, error: 'That message is no longer in the inbox.' }
      }
      if (!message.contactId) {
        return { ok: false as const, error: 'This reply is not linked to a contact yet.' }
      }

      const contact = await db().contact.findUniqueOrThrow({ where: { id: message.contactId } })
      const actions: string[] = []
      const now = new Date()

      if (intent === 'unsubscribe') {
        if (contact.email) {
          await db().suppressionEntry.upsert({
            where: { tenantId_type_value: { tenantId: tid(), type: 'email', value: contact.email } },
            update: { reason: 'unsubscribe' },
            create: { tenantId: tid(), type: 'email', value: contact.email, reason: 'unsubscribe' },
          })
        }
        await db().contact.update({
          where: { id: contact.id },
          data: { unsubscribedAt: now, status: 'do_not_contact' },
        })
        actions.push('suppressed')
      } else if (intent === 'not_interested') {
        await db().contact.update({ where: { id: contact.id }, data: { status: 'unqualified' } })
        actions.push('marked unqualified')
      } else if (intent === 'interested') {
        await db().contact.update({ where: { id: contact.id }, data: { status: 'engaged' } })
        actions.push('marked engaged')
      }

      // Anything a person judged to be a real reply ends the sequence. The two
      // machine categories do not, which is the case a human most often has to
      // correct in the other direction: "this really was just an auto-reply".
      const stopping = !['out_of_office', 'auto_reply'].includes(intent)
      if (stopping) {
        const stopped = await db().sequenceEnrollment.updateMany({
          where: { contactId: contact.id, status: 'active' },
          data: {
            status: intent === 'unsubscribe' ? 'stopped_unsubscribed' : 'stopped_replied',
            stoppedAt: now,
            stopReason: `Reclassified by a person as: ${INTENT_LABEL[intent as ReplyIntent]}`,
            nextRunAt: null,
          },
        })
        if (stopped.count) actions.push(`stopped ${stopped.count} sequence(s)`)
      }

      await db().activity.create({
        data: {
          tenantId: tid(),
          type: 'note',
          summary: `Reply reclassified as ${INTENT_LABEL[intent as ReplyIntent]}`,
          detail: { messageId, intent, by: auth.user.id, correction: true },
          contactId: contact.id,
          accountId: contact.accountId,
          actorId: auth.user.id,
        },
      })

      await audit({
        actorId: auth.user.id,
        action: 'update',
        entity: 'email_message',
        entityId: messageId,
        after: { intent },
      })

      revalidatePath('/inbox')
      revalidatePath(`/contacts/${contact.id}`)
      return { ok: true as const, actions }
    })
  } catch (err) {
    logger.error({ err, messageId }, 'reclassify failed')
    return { ok: false, error: 'Could not update that reply.' }
  }
}

/** Closes the review task for a reply the rep has now dealt with. */
export async function markHandled(messageId: string): Promise<TriageResult> {
  const auth = await requirePermission('task:update')

  try {
    return await withTenant(auth.tenant.id, async () => {
      const message = await db().emailMessage.findUnique({
        where: { id: messageId },
        select: { contactId: true },
      })
      if (!message?.contactId) return { ok: false as const, error: 'Not linked to a contact.' }

      const { count } = await db().task.updateMany({
        where: { contactId: message.contactId, status: 'open', type: { in: ['follow_up', 'call'] } },
        data: { status: 'completed', completedAt: new Date(), outcome: 'handled from the inbox' },
      })

      revalidatePath('/inbox')
      revalidatePath('/tasks')
      return { ok: true as const, actions: count ? [`closed ${count} task(s)`] : ['nothing open'] }
    })
  } catch (err) {
    logger.error({ err, messageId }, 'markHandled failed')
    return { ok: false, error: 'Could not close the task.' }
  }
}
