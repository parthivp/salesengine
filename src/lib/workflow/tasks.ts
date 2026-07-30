import { db, tid } from '../db'
import type { Task, TaskType } from '@prisma/client'

/**
 * The rep's daily queue.
 *
 * The ordering rule matters more than it looks. A queue sorted purely by due date
 * puts a cold-list follow-up above a reply from a CRO who asked for pricing, and
 * a rep working top-down will do the wrong thing all morning. So priority
 * dominates, then overdue-ness, then due date.
 */

export type QueueBucket = 'overdue' | 'today' | 'upcoming' | 'snoozed'

export function bucketFor(task: Pick<Task, 'dueAt' | 'snoozedTo' | 'status'>, now = new Date()): QueueBucket {
  if (task.status === 'snoozed' && task.snoozedTo && task.snoozedTo > now) return 'snoozed'
  if (!task.dueAt) return 'upcoming'

  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  if (task.dueAt < now) return 'overdue'
  if (task.dueAt <= endOfToday) return 'today'
  return 'upcoming'
}

/**
 * Sort weight. Lower sorts first.
 *
 * Priority is scaled far above the time component so a priority-3 reply always
 * outranks a priority-0 task, however old.
 */
export function queueWeight(
  task: Pick<Task, 'priority' | 'dueAt' | 'type'>,
  now = new Date()
): number {
  const priorityWeight = (5 - Math.min(5, Math.max(0, task.priority))) * 1_000_000

  // Overdue tasks get a bonus that grows with age, capped so a two-month-old
  // task cannot outrank today's high-priority work forever.
  const dueMs = task.dueAt?.getTime() ?? now.getTime() + 7 * 86_400_000
  const overdueDays = Math.max(0, (now.getTime() - dueMs) / 86_400_000)
  const overdueWeight = -Math.min(overdueDays, 14) * 10_000

  const timeWeight = dueMs / 1_000_000

  // Replies-driven follow-ups edge ahead of cold touches at equal priority:
  // someone is waiting for an answer.
  const typeBonus: Partial<Record<TaskType, number>> = { follow_up: -5_000, meeting: -8_000 }

  return priorityWeight + overdueWeight + timeWeight + (typeBonus[task.type] ?? 0)
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  call: 'Call',
  email: 'Email',
  linkedin: 'LinkedIn',
  follow_up: 'Follow-up',
  meeting: 'Meeting',
  other: 'Task',
}

export const OUTCOMES: Record<TaskType, string[]> = {
  call: ['Connected', 'Voicemail', 'No answer', 'Wrong number', 'Not interested', 'Meeting booked'],
  email: ['Sent', 'Replied', 'Bounced'],
  linkedin: ['Sent', 'Accepted', 'Declined', 'No response'],
  follow_up: ['Done', 'Meeting booked', 'Not interested', 'Deferred'],
  meeting: ['Held', 'No-show', 'Rescheduled', 'Cancelled'],
  other: ['Done', 'Skipped'],
}

/**
 * Completing a task is rarely just a status change — the outcome usually implies
 * the next action. Encoding that here means a rep does not have to remember to
 * create the follow-up, which is exactly the step that gets skipped.
 */
export async function completeTask(opts: {
  taskId: string
  outcome?: string
  note?: string
  actorId: string
}): Promise<{ task: Task; followUpId?: string }> {
  const { taskId, outcome, note, actorId } = opts

  const task = await db().task.findUniqueOrThrow({ where: { id: taskId } })

  const updated = await db().task.update({
    where: { id: taskId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      outcome: outcome ?? null,
      note: note ? `${task.note ? `${task.note}\n\n` : ''}${note}` : task.note,
    },
  })

  await db().activity.create({
    data: {
      tenantId: tid(),
      type: 'note',
      summary: `${TASK_TYPE_LABEL[task.type]} completed${outcome ? `: ${outcome}` : ''}`,
      detail: note ? { note } : {},
      contactId: task.contactId,
      accountId: task.accountId,
      actorId,
    },
  })

  let followUpId: string | undefined

  const chain = nextStepFor(task.type, outcome)
  if (chain && task.contactId) {
    const followUp = await db().task.create({
      data: {
        tenantId: tid(),
        type: chain.type,
        title: chain.title,
        contactId: task.contactId,
        accountId: task.accountId,
        assigneeId: task.assigneeId,
        dueAt: new Date(Date.now() + chain.inDays * 86_400_000),
        priority: chain.priority,
      },
    })
    followUpId = followUp.id
  }

  // Outcomes that mean "stop" must actually stop outreach, not just close a task.
  if (outcome && /not interested|wrong number|do not contact/i.test(outcome) && task.contactId) {
    await db().contact.update({
      where: { id: task.contactId },
      data: { status: 'unqualified' },
    })
    await db().sequenceEnrollment.updateMany({
      where: { contactId: task.contactId, status: 'active' },
      data: {
        status: 'stopped_manual',
        stoppedAt: new Date(),
        stopReason: `Task outcome: ${outcome}`,
        nextRunAt: null,
      },
    })
  }

  if (outcome && /meeting booked/i.test(outcome) && task.contactId) {
    await db().contact.update({
      where: { id: task.contactId },
      data: { status: 'qualified' },
    })
  }

  return { task: updated, followUpId }
}

type Chain = { type: TaskType; title: string; inDays: number; priority: number }

function nextStepFor(type: TaskType, outcome?: string): Chain | null {
  if (!outcome) return null

  if (type === 'call') {
    if (/voicemail|no answer/i.test(outcome)) {
      return { type: 'call', title: 'Second call attempt', inDays: 2, priority: 1 }
    }
    if (/connected/i.test(outcome)) {
      return { type: 'follow_up', title: 'Send recap after call', inDays: 1, priority: 2 }
    }
    if (/meeting booked/i.test(outcome)) {
      return { type: 'meeting', title: 'Run discovery meeting', inDays: 3, priority: 3 }
    }
  }

  if (type === 'meeting') {
    if (/no-show/i.test(outcome)) {
      return { type: 'follow_up', title: 'Reschedule after no-show', inDays: 1, priority: 2 }
    }
    if (/held/i.test(outcome)) {
      return { type: 'follow_up', title: 'Send proposal / next steps', inDays: 2, priority: 3 }
    }
  }

  if (type === 'linkedin' && /accepted/i.test(outcome)) {
    return { type: 'follow_up', title: 'Message after connection accepted', inDays: 1, priority: 1 }
  }

  if (type === 'follow_up' && /deferred/i.test(outcome)) {
    return { type: 'follow_up', title: 'Check back in', inDays: 30, priority: 0 }
  }

  return null
}

export async function snoozeTask(taskId: string, until: Date, reason?: string) {
  return db().task.update({
    where: { id: taskId },
    data: {
      status: 'snoozed',
      snoozedTo: until,
      dueAt: until,
      note: reason ?? undefined,
    },
  })
}

export async function skipTask(taskId: string, reason?: string) {
  return db().task.update({
    where: { id: taskId },
    data: { status: 'skipped', completedAt: new Date(), outcome: reason ?? 'Skipped' },
  })
}

/**
 * Snoozed tasks whose time has come are returned to the open queue. Without
 * this they stay snoozed forever and quietly disappear from the rep's day.
 */
export async function wakeSnoozedTasks(now = new Date()): Promise<number> {
  const { count } = await db().task.updateMany({
    where: { status: 'snoozed', snoozedTo: { lte: now } },
    data: { status: 'open', snoozedTo: null },
  })
  return count
}
