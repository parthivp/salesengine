import { pagePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, AccessDenied, StatTile } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'
import { formatNumber } from '@/lib/utils'
import { currentPeriod, METRIC } from '@/lib/limits'
import { SettingsForm } from './client'

export const metadata = { title: 'Settings · SalesEngine' }
export const dynamic = 'force-dynamic'

type TenantSettings = {
  timezone?: string
  defaultSendWindowStart?: number
  defaultSendWindowEnd?: number
}

export default async function SettingsPage() {
  const guard = await pagePermission('admin:access')
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Settings" />
        <AccessDenied what="Workspace settings" role={ROLE_LABELS[guard.role]} />
      </>
    )
  }

  const { tenant, counters, seats } = await withTenant(guard.auth.tenant.id, async () => {
    const [tenant, counters, seats] = await Promise.all([
      db().tenant.findUniqueOrThrow({ where: { id: guard.auth.tenant.id } }),
      db().usageCounter.findMany({ where: { period: currentPeriod() } }),
      db().user.count({ where: { status: { in: ['active', 'invited'] } } }),
    ])
    return { tenant, counters, seats }
  })

  const settings = (tenant.settings ?? {}) as TenantSettings
  const used = (metric: string) => counters.find((c) => c.metric === metric)?.value ?? 0

  const quotas = [
    { label: 'Emails this month', used: used(METRIC.emailsSent), limit: tenant.monthlyEmailLimit },
    { label: 'Enrichment credits', used: used(METRIC.enrichCredits), limit: tenant.enrichCreditLimit },
    { label: 'Seats', used: seats, limit: tenant.seatLimit },
  ]

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace identity, defaults, and what this plan allows."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <SettingsForm
            name={tenant.name}
            timezone={settings.timezone ?? 'Asia/Kolkata'}
            windowStart={settings.defaultSendWindowStart ?? 9}
            windowEnd={settings.defaultSendWindowEnd ?? 17}
          />

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-1">Plan limits</h2>
            <p className="text-xs text-ink-500 mb-4">
              These are enforced, not advisory. The sequence engine defers rather than sends once the
              monthly email limit is reached, and resumes on the first of next month.
            </p>

            <div className="space-y-3">
              {quotas.map((q) => {
                const pct = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0
                const tone =
                  pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600'
                return (
                  <div key={q.label}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-ink-700">{q.label}</span>
                      <span className={pct >= 80 ? 'text-amber-800 font-medium' : 'text-ink-500'}>
                        {formatNumber(q.used)} / {formatNumber(q.limit)}
                      </span>
                    </div>
                    {/* A bar rather than a number alone: the useful question is how
                        much headroom is left, and a percentage answers it faster. */}
                    <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                      <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-3">This workspace</h2>
            <dl className="space-y-2.5 text-sm">
              <Row label="Plan">
                <Badge tone="brand">{tenant.plan}</Badge>
              </Row>
              <Row label="Status">
                <Badge tone={tenant.status === 'active' ? 'success' : 'warning'}>{tenant.status}</Badge>
              </Row>
              <Row label="Identifier">
                <code className="text-xs font-mono text-ink-600">{tenant.slug}</code>
              </Row>
              <Row label="Created">
                <span className="text-ink-600">{tenant.createdAt.toISOString().slice(0, 10)}</span>
              </Row>
            </dl>
          </Card>

          <StatTile
            label="Billing period"
            value={currentPeriod()}
            hint="quotas reset on the 1st, UTC"
          />

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-2">Changing a limit</h2>
            <p className="text-sm text-ink-600">
              Limits belong to the plan, so they are not editable from inside the workspace — a
              workspace that can raise its own ceiling does not have one. They are changed from the
              platform side.
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
