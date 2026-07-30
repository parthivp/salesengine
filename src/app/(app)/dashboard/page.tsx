import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, StatTile, Card, Badge } from '@/components/ui'
import { formatNumber, formatRelative } from '@/lib/utils'

export const metadata = { title: 'Dashboard · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const auth = await requireAuth()

  const data = await withTenant(auth.tenant.id, async () => {
    const [contacts, accounts, leads, openTasks, activeSequences, recentAudit] =
      await Promise.all([
        db().contact.count(),
        db().account.count(),
        db().lead.count({ where: { status: 'new' } }),
        db().task.count({ where: { status: 'open' } }),
        db().sequence.count({ where: { status: 'active' } }),
        db().auditLog.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: { actor: { select: { name: true } } },
        }),
      ])
    return { contacts, accounts, leads, openTasks, activeSequences, recentAudit }
  })

  return (
    <>
      <PageHeader
        title={`Good to see you, ${auth.user.name.split(' ')[0]}`}
        description="Phase 1 is live: tenancy, authentication, roles and the audit trail."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
        <StatTile label="Contacts" value={formatNumber(data.contacts)} hint="Phase 2" />
        <StatTile label="Accounts" value={formatNumber(data.accounts)} hint="Phase 2" />
        <StatTile label="New leads" value={formatNumber(data.leads)} hint="Awaiting triage" />
        <StatTile label="Open tasks" value={formatNumber(data.openTasks)} hint="Phase 5" />
        <StatTile
          label="Active sequences"
          value={formatNumber(data.activeSequences)}
          hint="Phase 3"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="px-5 py-4 border-b border-ink-200">
            <h2 className="text-sm font-semibold text-ink-900">Delivery roadmap</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Each phase ships as a working, demoable system.
            </p>
          </div>
          <ul className="divide-y divide-ink-100">
            {ROADMAP.map((p) => (
              <li key={p.phase} className="flex items-start gap-3 px-5 py-3">
                <div className="mt-0.5">
                  {p.done ? (
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-100">
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                  ) : (
                    <span className="grid h-5 w-5 place-items-center rounded-full border border-ink-200 text-[10px] font-semibold text-ink-400">
                      {p.phase}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink-900">{p.title}</p>
                    {p.done && <Badge tone="success">Shipped</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-500">{p.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <div className="px-5 py-4 border-b border-ink-200">
            <h2 className="text-sm font-semibold text-ink-900">Recent activity</h2>
            <p className="mt-0.5 text-xs text-ink-500">From the audit trail.</p>
          </div>
          {data.recentAudit.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-500">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.recentAudit.map((a) => (
                <li key={a.id} className="px-5 py-3">
                  <p className="text-sm text-ink-900">
                    <span className="font-medium">{a.actor?.name ?? 'System'}</span>{' '}
                    <span className="text-ink-500">{a.action}</span>{' '}
                    <span className="text-ink-700">{a.entity}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">{formatRelative(a.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}

const ROADMAP = [
  { phase: 0, title: 'Scaffold', detail: 'Monorepo, Docker Compose, Prisma, worker process.', done: true },
  { phase: 1, title: 'Foundation', detail: 'Tenancy with Postgres RLS, auth, roles, teams, audit log.', done: true },
  { phase: 2, title: 'Lead database', detail: 'Contacts, accounts, CSV import, form capture, Apollo enrichment, scoring.', done: false },
  { phase: 3, title: 'Email engine', detail: 'SES, mailboxes, sequence builder, scheduler, deliverability guardrails.', done: false },
  { phase: 4, title: 'CRM sync', detail: 'Connector layer, Salesforce adapter, field mapping, bi-directional sync.', done: false },
  { phase: 5, title: 'Workflow', detail: 'Task queue, follow-ups, pipeline board, reporting.', done: false },
  { phase: 6, title: 'LinkedIn', detail: 'Sales Nav import, AI drafting, human-in-the-loop send queue.', done: false },
]
