import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Card({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('rounded-xl border border-ink-200 bg-white', className)}>
      {children}
    </div>
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'neutral' | 'positive' | 'warning'
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p
        className={cn(
          'mt-1.5 text-2xl font-semibold tabular-nums tracking-tight',
          tone === 'positive' && 'text-emerald-600',
          tone === 'warning' && 'text-amber-600',
          tone === 'neutral' && 'text-ink-900'
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </Card>
  )
}

const BADGE_TONES = {
  neutral: 'bg-ink-100 text-ink-600',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
} as const

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: keyof typeof BADGE_TONES
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone]
      )}
    >
      {children}
    </span>
  )
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
}: {
  title: string
  description?: string
  icon?: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
}) {
  return (
    <div className="text-center py-12 px-6">
      {Icon && (
        <div className="mx-auto h-10 w-10 rounded-lg bg-ink-100 grid place-items-center mb-3">
          <Icon className="h-5 w-5 text-ink-400" />
        </div>
      )}
      <p className="text-sm font-medium text-ink-900">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-ink-500 max-w-sm mx-auto">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function PhaseNotice({ phase, feature }: { phase: number; feature: string }) {
  return (
    <Card className="p-6 border-dashed">
      <div className="flex items-start gap-3">
        <Badge tone="brand">Phase {phase}</Badge>
        <div>
          <p className="text-sm font-medium text-ink-900">{feature} lands in Phase {phase}</p>
          <p className="mt-1 text-sm text-ink-500">
            The route, permissions and navigation are wired up now so the shell is complete;
            the implementation arrives with that phase.
          </p>
        </div>
      </div>
    </Card>
  )
}

/**
 * What a page renders when the signed-in role may not see it.
 *
 * Deliberately says which role the viewer has and who to ask, rather than a bare
 * "Forbidden". The commonest cause of someone hitting this is a stale link or a
 * role that was changed under them, and neither is helped by a dead end.
 */
export function AccessDenied({
  what,
  role,
  contact = 'a workspace owner or admin',
}: {
  what: string
  role: string
  contact?: string
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-lg bg-amber-50 border border-amber-200 grid place-items-center">
          <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-amber-700" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-ink-900">{what} is not available to your role</p>
          <p className="mt-1 text-sm text-ink-500">
            You are signed in as <span className="font-medium text-ink-700">{role}</span>. Ask{' '}
            {contact} if you need access.
          </p>
        </div>
      </div>
    </Card>
  )
}
