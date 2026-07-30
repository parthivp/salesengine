import { pagePermission } from '@/lib/auth'
import { PageHeader, Card, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'
import { assess, type Severity, type Check } from '@/lib/readiness'
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'

export const metadata = { title: 'Readiness · SalesEngine' }
export const dynamic = 'force-dynamic'

const ICON: Record<Severity, typeof Info> = {
  ok: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  blocker: XCircle,
}

const COLOUR: Record<Severity, string> = {
  ok: 'text-emerald-600',
  info: 'text-ink-400',
  warning: 'text-amber-600',
  blocker: 'text-red-600',
}

export default async function ReadinessPage() {
  const guard = await pagePermission('admin:access')
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Readiness" />
        <AccessDenied what="Readiness" role={ROLE_LABELS[guard.role]} />
      </>
    )
  }

  const result = await assess(guard.auth.tenant.id)

  const areas = [...new Set(result.checks.map((c) => c.area))]
  const byArea = (area: string) => result.checks.filter((c) => c.area === area)

  return (
    <>
      <PageHeader
        title="Readiness"
        description="Everything that has to be true before this runs a real pipeline. Each item here is a way the system can look healthy and do nothing."
      />

      <Card
        className={
          result.ready
            ? 'mb-6 p-5 border-emerald-200 bg-emerald-50/60'
            : 'mb-6 p-5 border-red-200 bg-red-50/60'
        }
      >
        <p className={result.ready ? 'text-sm font-medium text-emerald-900' : 'text-sm font-medium text-red-900'}>
          {result.ready
            ? result.warnings === 0
              ? 'Ready. Nothing is blocking and nothing is degraded.'
              : `Ready to send, with ${result.warnings} thing${result.warnings === 1 ? '' : 's'} degraded.`
            : `${result.blockers} blocker${result.blockers === 1 ? '' : 's'} — outreach will not run until ${
                result.blockers === 1 ? 'it is' : 'they are'
              } fixed.`}
        </p>
        {/* The distinction that matters: a blocker means nothing happens, a warning
            means something happens badly. Both look identical from the dashboard. */}
        <p className={result.ready ? 'mt-1 text-sm text-emerald-800' : 'mt-1 text-sm text-red-800'}>
          Run the same checks from a terminal with <code className="font-mono">npm run check</code>,
          which exits non-zero on a blocker.
        </p>
      </Card>

      <div className="space-y-6">
        {areas.map((area) => (
          <Card key={area}>
            <div className="px-5 py-3 border-b border-ink-100">
              <h2 className="text-sm font-semibold text-ink-900">{area}</h2>
            </div>
            <ul className="divide-y divide-ink-100">
              {byArea(area).map((c) => (
                <Row key={c.id} check={c} />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  )
}

function Row({ check }: { check: Check }) {
  const Icon = ICON[check.severity]
  return (
    <li className="px-5 py-3 flex items-start gap-3">
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${COLOUR[check.severity]}`} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900">{check.label}</p>
        <p className="mt-0.5 text-sm text-ink-600">{check.detail}</p>
        {check.fix && (
          <p className="mt-1 text-sm text-brand-800">
            <span className="text-ink-400">→ </span>
            {check.fix}
          </p>
        )}
      </div>
    </li>
  )
}
