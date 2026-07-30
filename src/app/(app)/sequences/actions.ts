'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'
import { lintContent } from '@/lib/email/deliverability'
import { enqueue } from '@/lib/queue'

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string }

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
})

export async function createSequence(input: z.input<typeof createSchema>): Promise<ActionResult<{ id: string }>> {
  const auth = await requirePermission('sequence:create')
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

  try {
    const id = await withTenant(auth.tenant.id, async () => {
      const clash = await db().sequence.findFirst({ where: { name: parsed.data.name } })
      if (clash) throw new Error('A sequence with that name already exists.')

      const seq = await db().sequence.create({
        data: {
          tenantId: tid(),
          name: parsed.data.name,
          description: parsed.data.description,
          createdById: auth.user.id,
          // A new sequence starts with one email step so the builder is never empty.
          steps: {
            create: {
              order: 1,
              type: 'email',
              delayMinutes: 0,
              subject: 'Quick question about {{company}}',
              bodyText:
                'Hi {{first_name | there}},\n\n' +
                'I noticed {{company}} is growing the team. Teams at that stage usually hit a wall ' +
                'somewhere specific — curious whether that matches your experience.\n\n' +
                'Worth a short call to compare notes?\n\n' +
                '{{sender_first_name}}',
            },
          },
        },
      })
      await audit({ actorId: auth.user.id, action: 'create', entity: 'Sequence', entityId: seq.id, after: { name: seq.name } })
      return seq.id
    })

    revalidatePath('/sequences')
    return { ok: true, data: { id } }
  } catch (err) {
    logger.error({ err }, 'createSequence failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create the sequence.' }
  }
}

export async function setSequenceStatus(
  sequenceId: string,
  status: 'draft' | 'active' | 'paused' | 'archived'
): Promise<ActionResult> {
  const auth = await requirePermission('sequence:update')

  try {
    await withTenant(auth.tenant.id, async () => {
      const seq = await db().sequence.findUniqueOrThrow({
        where: { id: sequenceId },
        include: { steps: true },
      })

      if (status === 'active') {
        // Activation gates. A sequence that goes live broken sends broken email
        // to real prospects, so these are refusals rather than warnings.
        if (!seq.steps.length) throw new Error('Add at least one step before activating.')

        const emailSteps = seq.steps.filter((s) => s.type === 'email')
        if (!emailSteps.length) throw new Error('A sequence needs at least one email step.')

        for (const step of emailSteps) {
          const subject = step.subject ?? ''
          const body = step.bodyText ?? ''
          if (!subject.trim()) throw new Error(`Step ${step.order} has no subject.`)
          if (!body.trim()) throw new Error(`Step ${step.order} has no body.`)

          const lint = lintContent({ subject, bodyText: body, hasUnsubscribe: true })
          if (lint.blocking) {
            const first = lint.findings.find((f) => f.severity === 'error')
            throw new Error(`Step ${step.order}: ${first?.message ?? 'content check failed'}.`)
          }
        }

        const mailboxes = await db().mailbox.count({ where: { health: { in: ['healthy', 'warming'] } } })
        if (!mailboxes) throw new Error('Connect a sending mailbox before activating.')
      }

      await db().sequence.update({ where: { id: sequenceId }, data: { status } })
      await audit({
        actorId: auth.user.id, action: 'update', entity: 'Sequence',
        entityId: sequenceId, after: { status },
      })
    })

    revalidatePath('/sequences')
    revalidatePath(`/sequences/${sequenceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not update the sequence.' }
  }
}

const stepSchema = z.object({
  sequenceId: z.string(),
  stepId: z.string().optional(),
  order: z.number().int().min(1).max(50),
  type: z.enum(['email', 'wait', 'task', 'call', 'linkedin_connect', 'linkedin_message']),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 90),
  subject: z.string().max(300).optional(),
  bodyText: z.string().max(20000).optional(),
  taskNote: z.string().max(2000).optional(),
  conditionType: z
    .enum(['always', 'if_opened', 'if_not_opened', 'if_clicked', 'if_not_clicked', 'if_no_reply'])
    .default('always'),
})

export async function upsertStep(input: z.input<typeof stepSchema>): Promise<ActionResult> {
  const auth = await requirePermission('sequence:update')
  const parsed = stepSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid step.' }

  const d = parsed.data

  try {
    await withTenant(auth.tenant.id, async () => {
      // Confirm the sequence belongs to this tenant before touching a child row:
      // SequenceStep carries no tenantId, so RLS cannot protect it directly.
      await db().sequence.findUniqueOrThrow({ where: { id: d.sequenceId } })

      const data = {
        order: d.order,
        type: d.type,
        delayMinutes: d.delayMinutes,
        subject: d.subject,
        bodyText: d.bodyText,
        taskNote: d.taskNote,
        conditions: d.conditionType === 'always' ? {} : { type: d.conditionType },
      }

      if (d.stepId) {
        const existing = await db().sequenceStep.findFirstOrThrow({
          where: { id: d.stepId, sequenceId: d.sequenceId },
        })
        await db().sequenceStep.update({ where: { id: existing.id }, data })
      } else {
        await db().sequenceStep.create({ data: { ...data, sequenceId: d.sequenceId } })
      }
    })

    revalidatePath(`/sequences/${d.sequenceId}`)
    return { ok: true }
  } catch (err) {
    logger.error({ err }, 'upsertStep failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the step.' }
  }
}

export async function deleteStep(sequenceId: string, stepId: string): Promise<ActionResult> {
  const auth = await requirePermission('sequence:update')
  try {
    await withTenant(auth.tenant.id, async () => {
      await db().sequence.findUniqueOrThrow({ where: { id: sequenceId } })
      await db().sequenceStep.deleteMany({ where: { id: stepId, sequenceId } })
    })
    revalidatePath(`/sequences/${sequenceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not delete the step.' }
  }
}

export async function enrolContacts(
  sequenceId: string,
  scope: { listId?: string; contactIds?: string[]; status?: string }
): Promise<ActionResult<{ queued: number }>> {
  const auth = await requirePermission('sequence:enroll')

  try {
    const contactIds = await withTenant(auth.tenant.id, async () => {
      if (scope.contactIds?.length) return scope.contactIds
      if (scope.listId) {
        const members = await db().contactListMember.findMany({
          where: { listId: scope.listId },
          select: { contactId: true },
          take: 5000,
        })
        return members.map((m) => m.contactId)
      }
      const contacts = await db().contact.findMany({
        where: {
          email: { not: null },
          unsubscribedAt: null,
          bouncedAt: null,
          status: scope.status ? (scope.status as never) : { not: 'do_not_contact' },
        },
        select: { id: true },
        take: 5000,
      })
      return contacts.map((c) => c.id)
    })

    if (!contactIds.length) return { ok: false, error: 'No eligible contacts to enrol.' }

    // Enrollment runs in the worker: 5,000 contacts is not a request-cycle job.
    await enqueue('sequence:enroll', {
      tenantId: auth.tenant.id,
      sequenceId,
      contactIds,
      enrolledById: auth.user.id,
    })

    revalidatePath(`/sequences/${sequenceId}`)
    return { ok: true, data: { queued: contactIds.length } }
  } catch (err) {
    logger.error({ err }, 'enrolContacts failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not enrol contacts.' }
  }
}
