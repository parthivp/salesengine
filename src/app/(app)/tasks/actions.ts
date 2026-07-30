'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { completeTask, snoozeTask, skipTask } from '@/lib/workflow/tasks'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'

export type Result = { ok: true; followUp?: string } | { ok: false; error: string }

const completeSchema = z.object({
  taskId: z.string().min(1),
  outcome: z.string().trim().max(120).optional(),
  note: z.string().trim().max(4000).optional(),
})

export async function complete(input: z.input<typeof completeSchema>): Promise<Result> {
  const auth = await requireAuth()
  const parsed = completeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  try {
    const result = await withTenant(auth.tenant.id, async () => {
      // A rep may only close their own work unless they manage the team.
      const task = await db().task.findUniqueOrThrow({ where: { id: parsed.data.taskId } })
      if (auth.user.role === 'rep' && task.assigneeId && task.assigneeId !== auth.user.id) {
        throw new Error('That task belongs to someone else.')
      }

      const r = await completeTask({ ...parsed.data, actorId: auth.user.id })
      await audit({
        actorId: auth.user.id, action: 'update', entity: 'Task',
        entityId: task.id, after: { status: 'completed', outcome: parsed.data.outcome },
      })
      return r
    })

    revalidatePath('/tasks')
    revalidatePath('/dashboard')
    return { ok: true, followUp: result.followUpId }
  } catch (err) {
    logger.error({ err }, 'complete task failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not complete the task.' }
  }
}

export async function snooze(taskId: string, days: number, reason?: string): Promise<Result> {
  const auth = await requireAuth()
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return { ok: false, error: 'Snooze between 1 and 365 days.' }
  }

  try {
    await withTenant(auth.tenant.id, async () => {
      await db().task.findUniqueOrThrow({ where: { id: taskId } })
      await snoozeTask(taskId, new Date(Date.now() + days * 86_400_000), reason)
    })
    revalidatePath('/tasks')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not snooze.' }
  }
}

export async function skip(taskId: string, reason?: string): Promise<Result> {
  const auth = await requireAuth()
  try {
    await withTenant(auth.tenant.id, async () => {
      await db().task.findUniqueOrThrow({ where: { id: taskId } })
      await skipTask(taskId, reason)
    })
    revalidatePath('/tasks')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not skip.' }
  }
}

const createSchema = z.object({
  type: z.enum(['call', 'email', 'linkedin', 'follow_up', 'meeting', 'other']),
  title: z.string().trim().min(2).max(200),
  contactId: z.string().optional(),
  inDays: z.number().int().min(0).max(365).default(0),
  priority: z.number().int().min(0).max(3).default(1),
})

export async function createTask(input: z.input<typeof createSchema>): Promise<Result> {
  const auth = await requireAuth()
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid task.' }
  const d = parsed.data

  try {
    await withTenant(auth.tenant.id, async () => {
      const contact = d.contactId
        ? await db().contact.findUnique({ where: { id: d.contactId }, select: { id: true, accountId: true } })
        : null

      await db().task.create({
        data: {
          tenantId: auth.tenant.id,
          type: d.type,
          title: d.title,
          contactId: contact?.id,
          accountId: contact?.accountId,
          assigneeId: auth.user.id,
          dueAt: new Date(Date.now() + d.inDays * 86_400_000),
          priority: d.priority,
        },
      })
    })
    revalidatePath('/tasks')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create the task.' }
  }
}
