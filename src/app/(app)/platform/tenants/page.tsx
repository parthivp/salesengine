import { pagePlatformAdmin } from '@/lib/auth'
import { prismaAdmin } from '@/lib/db'
import { PageHeader, Card, Badge, AccessDenied, StatTile } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'
import { formatNumber, formatRelative } from '@/lib/utils'
import { currentPeriod, METRIC } from '@/lib/limits'

export const metadata = { title: 'Tenants · SalesEngine' }
export const dynamic = 'force-dynamic'

/**
 * The cross-tenant operator view.
 *
 * Every query here uses `prismaAdmin` — the owner role, which bypasses row-level
 * security — because the whole purpose is to see across tenants, and RLS would
 * scope it to whichever one the operator happens to belong to. That makes
 * `pagePlatformAdmin` the only thing standing between a visitor and every
 * workspace's numbers, so it is checked before a single query runs.
 *
 * What is deliberately *not* here: contacts, emails, message bodies. An operator
 * needs volumes and health to run the platform, not the contents of anyone's
 * pipeline. Counts and configuration only.
 */
export default async function TenantsPage() {
  const guard = await pagePlatformAdmin()
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Tenants" />
        <AccessDenied
          what="Platform administration"
          role={ROLE_LABELS[guard.role]}
          contact="whoever operates this deployment"
        />
      </>
    )
  }

  const period = currentPeriod()

  const tenants = await prismaAdmin.tenant.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { users: true, contacts: true, sequences: true, mailboxes: true } },
      usageCounters: { where: { period } },
    },
  })

  const totals = {
    tenants: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    users: tenants.reduce((n, t) => n + t._count.users, 0),
    contacts: tenants.reduce((n, t) => n + t._count.contacts, 0),
    emails: tenants.reduce(
      (n, t) => n + (t.usageCounters.find((c) => c.metric === METRIC.emailsSent)?.value ?? 0),
      0
    ),
  }

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Every workspace in this deployment. Volumes and configuration only — no contact or message data."
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatTile label="Workspaces" value={String(totals.tenants)} hint={`${totals.active} active`} />
        <StatTile label="Users" value={formatNumber(totals.users)} />
        <StatTile label="Contacts" value={formatNumber(totals.contacts)} />
        <StatTile label="Emails this month" value={formatNumber(totals.emails)} hint={period} />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
                <th className="px-5 py-2.5 font-medium">Workspace</th>
                <th className="px-5 py-2.5 font-medium">Plan</th>
                <th className="px-5 py-2.5 font-medium text-right">Seats</th>
                <th className="px-5 py-2.5 font-medium text-right">Contacts</th>
                <th className="px-5 py-2.5 font-medium text-right">Sequences</th>
                <th className="px-5 py-2.5 font-medium text-right">Mailboxes</th>
                <th className="px-5 py-2.5 font-medium text-right">Emails ({period})</th>
                <th className="px-5 py-2.5 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {tenants.map((t) => {
                const sent = t.usageCounters.find((c) => c.metric === METRIC.emailsSent)?.value ?? 0
                const emailPct = t.monthlyEmailLimit > 0 ? (sent / t.monthlyEmailLimit) * 100 : 0
                const seatPct = t.seatLimit > 0 ? (t._count.users / t.seatLimit) * 100 : 0
                return (
                  <tr key={t.id} className="hover:bg-ink-50/60">
                    <td className="px-5 py-3">
                      <p className="font-medium text-ink-900">{t.name}</p>
                      <code className="text-xs font-mono text-ink-400">{t.slug}</code>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        <Badge tone="brand">{t.plan}</Badge>
                        {t.status !== 'active' && <Badge tone="warning">{t.status}</Badge>}
                      </div>
                    </td>
                    <Quota value={t._count.users} limit={t.seatLimit} pct={seatPct} />
                    <td className="px-5 py-3 text-right text-ink-700">
                      {formatNumber(t._count.contacts)}
                    </td>
                    <td className="px-5 py-3 text-right text-ink-700">{t._count.sequences}</td>
                    <td className="px-5 py-3 text-right text-ink-700">{t._count.mailboxes}</td>
                    <Quota value={sent} limit={t.monthlyEmailLimit} pct={emailPct} />
                    <td className="px-5 py-3 text-ink-500 text-xs">{formatRelative(t.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="mt-4 text-xs text-ink-400">
        Reads bypass row-level security by necessity, so this page is gated on the platform-admin
        flag rather than on any role inside a workspace — a tenant owner has every permission in
        their own workspace and still cannot see this.
      </p>
    </>
  )
}

/** A count against its limit, coloured once it is worth noticing. */
function Quota({ value, limit, pct }: { value: number; limit: number; pct: number }) {
  return (
    <td className="px-5 py-3 text-right">
      <span className={pct >= 100 ? 'text-red-700 font-medium' : pct >= 80 ? 'text-amber-800' : 'text-ink-700'}>
        {formatNumber(value)}
      </span>
      <span className="text-ink-400"> / {formatNumber(limit)}</span>
    </td>
  )
}
