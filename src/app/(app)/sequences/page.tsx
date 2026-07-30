import Link from 'next/link'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, EmptyState, StatTile } from '@/components/ui'
import { formatNumber, formatRelative } from '@/lib/utils'
import { Send } from 'lucide-react'
import type { SequenceStatus } from '@prisma/client'
import { NewSequenceButton } from './new-sequence'

export const metadata = { title: 'Sequences · SalesEngine' }
export const dynamic = 'force-dynamic'

const STATUS_TONE: Record<SequenceStatus, 'neutral' | 'brand' | 'success' | 'warning'> = {
  draft: 'neutral',
  pending_approval: 'warning',
  active: 'success',
  paused: 'warning',
  archived: 'neutral',
}

export default async function SequencesPage() {
  const auth = await requirePermission('sequence:read')

  const { sequences, totals } = await withTenant(auth.tenant.id, async () => {
    const sequences = await db().sequence.findMany({
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: {
        _count: { select: { steps: true, enrollments: true } },
      },
    })

    const [active, enrolled, sent, replied] = await Promise.all([
      db().sequenceEnrollment.count({ where: { status: 'active' } }),
      db().sequenceEnrollment.count(),
      db().emailMessage.count({ where: { direction: 'outbound', sentAt: { not: null } } }),
      db().emailMessage.count({ where: { direction: 'inbound' } }),
    ])

    return { sequences, totals: { active, enrolled, sent, replied } }
  })

  const replyRate = totals.sent ? (totals.replied / totals.sent) * 100 : 0

  return (
    <>
      <PageHeader
        title="Sequences"
        description="Multi-step outreach with sending windows, branching and deliverability guardrails."
        action={<NewSequenceButton />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile label="Active enrollments" value={formatNumber(totals.active)} />
        <StatTile label="Total enrolled" value={formatNumber(totals.enrolled)} />
        <StatTile label="Emails sent" value={formatNumber(totals.sent)} />
        <StatTile
          label="Reply rate"
          value={`${replyRate.toFixed(1)}%`}
          hint={`${formatNumber(totals.replied)} replies`}
          tone={replyRate >= 5 ? 'positive' : 'neutral'}
        />
      </div>

      <Card>
        {sequences.length === 0 ? (
          <EmptyState
            icon={Send}
            title="No sequences yet"
            description="A sequence is an ordered set of steps — emails, waits, conditions and tasks — that runs automatically for every contact you enrol."
            action={<NewSequenceButton />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
                  <th className="px-5 py-2.5 font-medium">Sequence</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Steps</th>
                  <th className="px-5 py-2.5 font-medium">Enrolled</th>
                  <th className="px-5 py-2.5 font-medium">Window</th>
                  <th className="px-5 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {sequences.map((s) => (
                  <tr key={s.id} className="hover:bg-ink-50/60">
                    <td className="px-5 py-3">
                      <Link href={`/sequences/${s.id}`} className="group block">
                        <p className="font-medium text-ink-900 group-hover:text-brand-700">
                          {s.name}
                        </p>
                        {s.description && (
                          <p className="text-xs text-ink-500 truncate max-w-sm">{s.description}</p>
                        )}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[s.status]}>{s.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-5 py-3 tabular-nums text-ink-700">{s._count.steps}</td>
                    <td className="px-5 py-3 tabular-nums text-ink-700">{s._count.enrollments}</td>
                    <td className="px-5 py-3 text-ink-600 text-xs">
                      {s.sendWindowStart}:00–{s.sendWindowEnd}:00 ·{' '}
                      {s.sendDays.length === 5 ? 'weekdays' : `${s.sendDays.length} days`}
                    </td>
                    <td className="px-5 py-3 text-ink-500">{formatRelative(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
