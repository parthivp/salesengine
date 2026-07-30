import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, StatTile, EmptyState } from '@/components/ui'
import { formatNumber } from '@/lib/utils'
import { bucketFor, queueWeight, wakeSnoozedTasks, type QueueBucket } from '@/lib/workflow/tasks'
import { ListChecks } from 'lucide-react'
import { TaskQueue, NewTaskButton } from './client'

export const metadata = { title: 'My tasks · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const auth = await requireAuth()
  const sp = await searchParams
  const teamView = sp.view === 'team' && auth.user.role !== 'rep'

  const { tasks, counts } = await withTenant(auth.tenant.id, async () => {
    // Snoozed tasks whose time has come rejoin the queue on load, so nothing
    // quietly disappears from a rep's day.
    await wakeSnoozedTasks()

    const where = teamView ? {} : { assigneeId: auth.user.id }

    const rows = await db().task.findMany({
      where: { ...where, status: { in: ['open', 'snoozed'] } },
      include: {
        contact: {
          select: {
            id: true, firstName: true, lastName: true, email: true, title: true,
            account: { select: { name: true } },
          },
        },
        assignee: { select: { name: true } },
      },
      take: 300,
    })

    const completedToday = await db().task.count({
      where: {
        ...where,
        status: 'completed',
        completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    })

    // If this user's own queue is empty, find out whether the team's is too.
    // An admin landing on "nothing here" while 12 tasks sit with the team is a
    // dead end, not an empty state.
    const teamOpen =
      rows.length === 0 && !teamView
        ? await db().task.count({ where: { status: { in: ['open', 'snoozed'] } } })
        : 0

    return { tasks: rows, counts: { completedToday, teamOpen } }
  })

  const now = new Date()
  const withBuckets = tasks
    .map((t) => ({ task: t, bucket: bucketFor(t, now), weight: queueWeight(t, now) }))
    .sort((a, b) => a.weight - b.weight)

  const grouped: Record<QueueBucket, typeof withBuckets> = {
    overdue: withBuckets.filter((x) => x.bucket === 'overdue'),
    today: withBuckets.filter((x) => x.bucket === 'today'),
    upcoming: withBuckets.filter((x) => x.bucket === 'upcoming'),
    snoozed: withBuckets.filter((x) => x.bucket === 'snoozed'),
  }

  const serialise = (rows: typeof withBuckets) =>
    rows.map(({ task, bucket }) => ({
      id: task.id,
      type: task.type,
      title: task.title,
      note: task.note,
      priority: task.priority,
      dueAt: task.dueAt?.toISOString() ?? null,
      snoozedTo: task.snoozedTo?.toISOString() ?? null,
      bucket,
      assignee: task.assignee?.name ?? null,
      payload: (task.payload ?? {}) as Record<string, unknown>,
      contact: task.contact
        ? {
            id: task.contact.id,
            name:
              [task.contact.firstName, task.contact.lastName].filter(Boolean).join(' ') ||
              task.contact.email ||
              'Unknown',
            title: task.contact.title,
            company: task.contact.account?.name ?? null,
          }
        : null,
    }))

  return (
    <>
      <PageHeader
        title={teamView ? "The team's tasks" : 'My tasks'}
        description="Priority first, then overdue, then due date — so a reply never sits under a month of cold follow-ups."
        action={<NewTaskButton />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Overdue"
          value={formatNumber(grouped.overdue.length)}
          tone={grouped.overdue.length > 0 ? 'warning' : 'neutral'}
        />
        <StatTile label="Due today" value={formatNumber(grouped.today.length)} />
        <StatTile label="Upcoming" value={formatNumber(grouped.upcoming.length)} />
        <StatTile
          label="Done today"
          value={formatNumber(counts.completedToday)}
          tone={counts.completedToday > 0 ? 'positive' : 'neutral'}
        />
      </div>

      {auth.user.role !== 'rep' && (
        <div className="mb-4 flex gap-2 text-sm">
          <a
            href="/tasks"
            className={
              !teamView
                ? 'rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white'
                : 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-ink-600 hover:bg-ink-50'
            }
          >
            Mine
          </a>
          <a
            href="/tasks?view=team"
            className={
              teamView
                ? 'rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white'
                : 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-ink-600 hover:bg-ink-50'
            }
          >
            Whole team
          </a>
        </div>
      )}

      {withBuckets.length === 0 ? (
        <Card>
          {counts.teamOpen > 0 ? (
            <EmptyState
              icon={ListChecks}
              title="Nothing assigned to you"
              description={`Your own queue is clear. The team has ${counts.teamOpen} open ${
                counts.teamOpen === 1 ? 'task' : 'tasks'
              } — switch to the team view to see them.`}
              action={
                <a
                  href="/tasks?view=team"
                  className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
                >
                  View the team’s tasks
                </a>
              }
            />
          ) : (
            <EmptyState
              icon={ListChecks}
              title="Nothing in the queue"
              description="Tasks appear here when a prospect replies, a sequence reaches a manual step, or you add one yourself."
              action={<NewTaskButton />}
            />
          )}
        </Card>
      ) : (
        <div className="space-y-6">
          {(['overdue', 'today', 'upcoming', 'snoozed'] as QueueBucket[]).map((bucket) => {
            const rows = grouped[bucket]
            if (!rows.length) return null
            return (
              <TaskQueue
                key={bucket}
                bucket={bucket}
                tasks={serialise(rows)}
                showAssignee={teamView}
              />
            )
          })}
        </div>
      )}
    </>
  )
}
