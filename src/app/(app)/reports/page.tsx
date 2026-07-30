import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, StatTile, Badge, EmptyState } from '@/components/ui'
import { formatNumber, formatCurrency } from '@/lib/utils'
import {
  sequenceFunnels, repLeaderboard, activitySeries, deliverabilitySummary,
  MIN_DENOMINATOR,
} from '@/lib/workflow/reports'
import { computeForecast } from '@/lib/workflow/pipeline'
import { FunnelChart, TrendChart } from '@/components/charts'
import { BarChart3, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'

export const metadata = { title: 'Reports · SalesEngine' }
export const dynamic = 'force-dynamic'

/** Status colours are reserved, and always ship with an icon + label. */
const VERDICT = {
  healthy: { label: 'Healthy', icon: ShieldCheck, colour: '#0ca30c', tone: 'success' as const },
  watch: { label: 'Watch', icon: ShieldAlert, colour: '#fab219', tone: 'warning' as const },
  act: { label: 'Act now', icon: ShieldX, colour: '#d03b3b', tone: 'danger' as const },
}

export default async function ReportsPage() {
  const auth = await requirePermission('report:read')

  const data = await withTenant(auth.tenant.id, async () => {
    const [funnels, reps, series, deliverability, deals] = await Promise.all([
      sequenceFunnels(6),
      repLeaderboard(),
      activitySeries(30),
      deliverabilitySummary(),
      db().deal.findMany({ include: { stage: true } }),
    ])
    return { funnels, reps, series, deliverability, forecast: computeForecast(deals) }
  })

  const { funnels, reps, series, deliverability, forecast } = data
  const verdict = VERDICT[deliverability.verdict]
  const VerdictIcon = verdict.icon

  const totalSent = series.reduce((n, p) => n + p.sent, 0)
  const totalReplies = series.reduce((n, p) => n + p.replies, 0)
  const totalTasks = series.reduce((n, p) => n + p.tasks, 0)

  return (
    <>
      <PageHeader
        title="Reports"
        description="Rates are suppressed below a meaningful sample — a rep with 3 sends and 1 reply is not a 33% performer."
      />

      {/* KPI row of stat tiles, not a grouped bar chart of four numbers. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile label="Sent, 30 days" value={formatNumber(totalSent)} />
        <StatTile
          label="Replies, 30 days"
          value={formatNumber(totalReplies)}
          hint={
            totalSent >= MIN_DENOMINATOR
              ? `${((totalReplies / totalSent) * 100).toFixed(1)}% reply rate`
              : 'too few sends to rate'
          }
          tone={totalReplies > 0 ? 'positive' : 'neutral'}
        />
        <StatTile label="Tasks done, 30 days" value={formatNumber(totalTasks)} />
        <StatTile
          label="Weighted pipeline"
          value={formatCurrency(forecast.weightedValue)}
          hint={`${formatNumber(forecast.openCount)} open deals`}
        />
      </div>

      {/* Deliverability leads, because it is the number that ends a domain. */}
      <Card className="mb-6">
        <div className="px-5 py-4 border-b border-ink-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Deliverability</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              AWS suspends accounts above 5% bounce or 0.1% complaint. We pause before either.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 shrink-0">
            <VerdictIcon className="h-4 w-4" style={{ color: verdict.colour }} aria-hidden />
            <Badge tone={verdict.tone}>{verdict.label}</Badge>
          </span>
        </div>
        <dl className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <Metric label="Sent" value={formatNumber(deliverability.sent)} />
          <Metric
            label="Bounce rate"
            value={
              deliverability.bounceRate == null
                ? '—'
                : `${deliverability.bounceRate.toFixed(2)}%`
            }
            hint={deliverability.bounceRate == null ? 'under 50 sends' : `${deliverability.bounced} bounced`}
            bad={deliverability.bounceRate != null && deliverability.bounceRate >= 3}
          />
          <Metric
            label="Complaint rate"
            value={
              deliverability.complaintRate == null
                ? '—'
                : `${deliverability.complaintRate.toFixed(3)}%`
            }
            hint={
              deliverability.complaintRate == null
                ? 'under 50 sends'
                : `${deliverability.complained} complaints`
            }
            bad={deliverability.complaintRate != null && deliverability.complaintRate >= 0.05}
          />
          <Metric
            label="Unsubscribes"
            value={formatNumber(deliverability.unsubscribed)}
            hint={
              deliverability.unsubscribeRate == null
                ? 'under 50 sends'
                : `${deliverability.unsubscribeRate.toFixed(2)}% of sends`
            }
          />
        </dl>
      </Card>

      <div className="space-y-6">
        <TrendChart
          title="Activity, last 30 days"
          subtitle="All three are counts, so they share one axis — two scales on one plot would invent a correlation."
          points={series}
        />

        {funnels.length === 0 ? (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="No sequences to report on"
              description="Activate a sequence and enrol contacts; the funnel appears once there is something to measure."
            />
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {funnels.map((f) => (
              <FunnelChart
                key={f.sequenceId}
                title={f.name}
                subtitle={
                  f.replyRate == null
                    ? `${formatNumber(f.sent)} sent — too few to quote a reply rate`
                    : `${f.replyRate.toFixed(1)}% reply rate from ${formatNumber(f.sent)} sends`
                }
                stages={[
                  { label: 'Enrolled', count: f.enrolled },
                  { label: 'Sent', count: f.sent },
                  { label: 'Opened', count: f.opened },
                  { label: 'Clicked', count: f.clicked },
                  { label: 'Replied', count: f.replied },
                ]}
              />
            ))}
          </div>
        )}

        {/* Identity data across many people: a table, not more colours. */}
        <Card>
          <div className="px-5 py-4 border-b border-ink-200">
            <h2 className="text-sm font-semibold text-ink-900">Rep performance</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Ranked by outcomes, not activity. Sorting by emails sent rewards volume — the
              behaviour that burns a sending domain.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
                  <th className="px-5 py-2.5 font-medium">Rep</th>
                  <th className="px-5 py-2.5 font-medium text-right">Won</th>
                  <th className="px-5 py-2.5 font-medium text-right">Meetings</th>
                  <th className="px-5 py-2.5 font-medium text-right">Replies</th>
                  <th className="px-5 py-2.5 font-medium text-right">Reply rate</th>
                  <th className="px-5 py-2.5 font-medium text-right">Sent</th>
                  <th className="px-5 py-2.5 font-medium text-right">Tasks done</th>
                  <th className="px-5 py-2.5 font-medium text-right">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {reps.map((r) => (
                  <tr key={r.userId} className="hover:bg-ink-50/60">
                    <td className="px-5 py-2.5 text-ink-900">{r.name}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-900">
                      {r.wonValue > 0 ? formatCurrency(r.wonValue) : '—'}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-700">
                      {r.meetingsBooked || '—'}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-700">
                      {r.replied || '—'}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-700">
                      {r.replyRate == null ? (
                        <span title={`Fewer than ${MIN_DENOMINATOR} sends — not enough to rate`}>—</span>
                      ) : (
                        `${r.replyRate.toFixed(1)}%`
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-600">
                      {formatNumber(r.sent)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-600">
                      {formatNumber(r.tasksCompleted)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {r.tasksOverdue > 0 ? (
                        <span className="text-red-700 font-medium">{r.tasksOverdue}</span>
                      ) : (
                        <span className="text-ink-400">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  )
}

function Metric({
  label,
  value,
  hint,
  bad,
}: {
  label: string
  value: string
  hint?: string
  bad?: boolean
}) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      {/* Proportional figures on standalone values; tabular only in table columns. */}
      <dd className={bad ? 'text-lg font-semibold text-red-700' : 'text-lg font-semibold text-ink-900'}>
        {value}
      </dd>
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  )
}
