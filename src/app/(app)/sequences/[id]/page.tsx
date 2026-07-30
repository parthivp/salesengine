import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, StatTile } from '@/components/ui'
import { formatNumber, formatRelative } from '@/lib/utils'
import { lintContent } from '@/lib/email/deliverability'
import { unknownTags } from '@/lib/email/merge'
import { ArrowLeft, Mail, Clock, ListChecks, Phone, Linkedin, GitBranch } from 'lucide-react'
import { SequenceControls } from './controls'
import type { StepType } from '@prisma/client'

export const dynamic = 'force-dynamic'

const STEP_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  email: Mail,
  wait: Clock,
  task: ListChecks,
  call: Phone,
  linkedin_connect: Linkedin,
  linkedin_message: Linkedin,
  linkedin_view: Linkedin,
  condition: GitBranch,
}

const CONDITION_LABEL: Record<string, string> = {
  if_opened: 'only if a previous email was opened',
  if_not_opened: 'only if no previous email was opened',
  if_clicked: 'only if a link was clicked',
  if_not_clicked: 'only if no link was clicked',
  if_no_reply: 'only if they have not replied',
}

function humanDelay(minutes: number): string {
  if (minutes === 0) return 'immediately'
  if (minutes < 60) return `after ${minutes} min`
  if (minutes < 1440) {
    const h = Math.round(minutes / 60)
    return `after ${h} hour${h === 1 ? '' : 's'}`
  }
  const d = Math.round(minutes / 1440)
  return `after ${d} day${d === 1 ? '' : 's'}`
}

export default async function SequenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const auth = await requirePermission('sequence:read')
  const { id } = await params

  const data = await withTenant(auth.tenant.id, async () => {
    const sequence = await db().sequence.findUnique({
      where: { id },
      include: { steps: { orderBy: [{ order: 'asc' }] } },
    })
    if (!sequence) return null

    const [byStatus, sent, opened, clicked, replied, mailboxes, recent] = await Promise.all([
      db().sequenceEnrollment.groupBy({
        by: ['status'],
        where: { sequenceId: id },
        _count: { _all: true },
      }),
      db().emailMessage.count({ where: { enrollment: { sequenceId: id }, sentAt: { not: null } } }),
      db().emailMessage.count({ where: { enrollment: { sequenceId: id }, opensCount: { gt: 0 } } }),
      db().emailMessage.count({ where: { enrollment: { sequenceId: id }, clicksCount: { gt: 0 } } }),
      db().sequenceEnrollment.count({ where: { sequenceId: id, status: 'stopped_replied' } }),
      db().mailbox.count({ where: { health: { in: ['healthy', 'warming'] } } }),
      db().emailMessage.findMany({
        where: { enrollment: { sequenceId: id } },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { contact: { select: { id: true, firstName: true, lastName: true, email: true } } },
      }),
    ])

    const counts = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]))
    return { sequence, counts, sent, opened, clicked, replied, mailboxes, recent }
  })

  if (!data) notFound()
  const { sequence, counts, sent, opened, clicked, replied, mailboxes, recent } = data

  const totalEnrolled = Object.values(counts).reduce((a, b) => a + b, 0)
  const replyRate = sent ? (replied / sent) * 100 : 0

  return (
    <>
      <Link
        href="/sequences"
        className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to sequences
      </Link>

      <PageHeader
        title={sequence.name}
        description={sequence.description ?? undefined}
        action={
          <SequenceControls
            sequenceId={sequence.id}
            status={sequence.status}
            stepCount={sequence.steps.length}
            mailboxCount={mailboxes}
          />
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
        <StatTile label="Enrolled" value={formatNumber(totalEnrolled)} />
        <StatTile label="Active" value={formatNumber(counts.active ?? 0)} />
        <StatTile label="Sent" value={formatNumber(sent)} />
        <StatTile
          label="Replied"
          value={formatNumber(replied)}
          hint={`${replyRate.toFixed(1)}% of sends`}
          tone={replyRate >= 5 ? 'positive' : 'neutral'}
        />
        <StatTile
          label="Stopped"
          value={formatNumber(
            (counts.stopped_unsubscribed ?? 0) + (counts.stopped_bounced ?? 0) + (counts.failed ?? 0)
          )}
          hint="unsub, bounce or error"
          tone={
            (counts.stopped_bounced ?? 0) + (counts.failed ?? 0) > 0 ? 'warning' : 'neutral'
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <div className="px-5 py-4 border-b border-ink-200 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink-900">Steps</h2>
                <p className="mt-0.5 text-xs text-ink-500">
                  Runs top to bottom. Delays and conditions are evaluated per contact.
                </p>
              </div>
              <Badge>{sequence.steps.length} steps</Badge>
            </div>

            <ol className="divide-y divide-ink-100">
              {sequence.steps.map((step, i) => {
                const Icon = STEP_ICON[step.type] ?? Mail
                const cond = (step.conditions as { type?: string } | null)?.type
                const body = step.bodyText ?? ''
                const subject = step.subject ?? ''
                const lint =
                  step.type === 'email'
                    ? lintContent({ subject, bodyText: body, hasUnsubscribe: true })
                    : null
                const badTags = unknownTags(`${subject} ${body}`)

                return (
                  <li key={step.id} className="px-5 py-4">
                    <div className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <div className="h-7 w-7 rounded-lg bg-ink-100 grid place-items-center shrink-0">
                          <Icon className="h-3.5 w-3.5 text-ink-500" />
                        </div>
                        {i < sequence.steps.length - 1 && (
                          <div className="w-px flex-1 bg-ink-200 mt-1" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                            Step {step.order}
                          </span>
                          <Badge tone="brand">{step.type.replace(/_/g, ' ')}</Badge>
                          <span className="text-xs text-ink-500">{humanDelay(step.delayMinutes)}</span>
                          {step.variantGroup && <Badge tone="warning">A/B variant</Badge>}
                        </div>

                        {cond && CONDITION_LABEL[cond] && (
                          <p className="mt-1 text-xs text-amber-700 inline-flex items-center gap-1">
                            <GitBranch className="h-3 w-3" />
                            {CONDITION_LABEL[cond]}
                          </p>
                        )}

                        {step.type === 'email' ? (
                          <>
                            <p className="mt-2 text-sm font-medium text-ink-900">
                              {subject || <span className="text-red-600">No subject</span>}
                            </p>
                            <p className="mt-1 text-sm text-ink-600 whitespace-pre-line line-clamp-4">
                              {body || <span className="text-red-600">No body</span>}
                            </p>
                          </>
                        ) : (
                          <p className="mt-2 text-sm text-ink-600">{step.taskNote ?? '—'}</p>
                        )}

                        {badTags.length > 0 && (
                          <p className="mt-2 text-xs text-red-700">
                            Unknown merge {badTags.length === 1 ? 'tag' : 'tags'}:{' '}
                            {badTags.map((t) => `{{${t}}}`).join(', ')} — these will not resolve and
                            the send will be refused.
                          </p>
                        )}

                        {lint && lint.findings.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {lint.findings.map((f, k) => (
                              <li
                                key={k}
                                className={
                                  f.severity === 'error'
                                    ? 'text-xs text-red-700'
                                    : f.severity === 'warning'
                                      ? 'text-xs text-amber-700'
                                      : 'text-xs text-ink-500'
                                }
                              >
                                {f.message}
                                {f.detail ? ` — ${f.detail}` : ''}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">Sending rules</h2>
            </div>
            <dl className="p-5 space-y-2.5 text-sm">
              <Row label="Window">
                {sequence.sendWindowStart}:00 – {sequence.sendWindowEnd}:00, prospect's timezone
              </Row>
              <Row label="Days">{dayNames(sequence.sendDays)}</Row>
              <Row label="Daily enrol cap">{formatNumber(sequence.dailyEnrollCap)}</Row>
              <Row label="Stop on reply">{sequence.stopOnReply ? 'Yes' : 'No'}</Row>
              <Row label="Stop if a colleague replies">
                {sequence.stopOnAccountReply ? 'Yes' : 'No'}
              </Row>
              <Row label="Open tracking">{sequence.trackOpens ? 'On' : 'Off'}</Row>
              <Row label="Click tracking">{sequence.trackClicks ? 'On' : 'Off'}</Row>
            </dl>
            {!sequence.trackOpens && (
              <p className="px-5 pb-4 text-xs text-ink-500">
                Open tracking is off by default. Apple Mail Privacy Protection and Gmail's image
                proxy pre-fetch pixels, so opens over-report and the pixel itself is a minor
                deliverability cost.
              </p>
            )}
          </Card>

          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">Engagement</h2>
            </div>
            <dl className="p-5 space-y-2.5 text-sm">
              <Row label="Sent">{formatNumber(sent)}</Row>
              <Row label="Opened">
                {formatNumber(opened)}
                {sent ? ` (${((opened / sent) * 100).toFixed(0)}%)` : ''}
              </Row>
              <Row label="Clicked">
                {formatNumber(clicked)}
                {sent ? ` (${((clicked / sent) * 100).toFixed(0)}%)` : ''}
              </Row>
              <Row label="Replied">
                {formatNumber(replied)}
                {sent ? ` (${replyRate.toFixed(1)}%)` : ''}
              </Row>
            </dl>
          </Card>

          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">Recent messages</h2>
            </div>
            {recent.length === 0 ? (
              <p className="px-5 py-5 text-sm text-ink-500">
                Nothing sent yet. Enrol contacts to start.
              </p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {recent.map((m) => (
                  <li key={m.id} className="px-5 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={m.contact ? `/contacts/${m.contact.id}` : '#'}
                        className="text-sm text-ink-900 truncate hover:text-brand-700"
                      >
                        {m.toEmail || m.fromEmail}
                      </Link>
                      <Badge
                        tone={
                          m.status === 'bounced' || m.status === 'failed' || m.status === 'complained'
                            ? 'danger'
                            : m.status === 'replied'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {m.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-ink-500 truncate">{m.subject}</p>
                    <p className="text-xs text-ink-400">{formatRelative(m.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-ink-500 shrink-0">{label}</dt>
      <dd className="text-ink-900 text-right">{children}</dd>
    </div>
  )
}

function dayNames(days: number[]): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (days.length === 7) return 'Every day'
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'Weekdays'
  if (!days.length) return 'None — this sequence cannot send'
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => names[d])
    .join(', ')
}
