import Link from 'next/link'
import { pagePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, EmptyState, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'
import { formatRelative, initials } from '@/lib/utils'
import { Shield } from 'lucide-react'
import type { AuditAction, Prisma } from '@prisma/client'

export const metadata = { title: 'Audit log · SalesEngine' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const ACTION_TONE: Record<AuditAction, 'success' | 'warning' | 'danger' | 'brand' | 'neutral'> = {
  create: 'success',
  update: 'brand',
  delete: 'danger',
  login: 'neutral',
  logout: 'neutral',
  invite: 'brand',
  impersonate: 'warning',
  connect: 'success',
  disconnect: 'warning',
  export: 'warning',
  other: 'neutral',
}

/** Fields never rendered, whatever a caller passed to `audit()`. */
const REDACT = /password|secret|token|credential|apikey|api_key|hash|authorization/i

/**
 * Renders a before/after pair as a short list of changed fields.
 *
 * Redaction happens here rather than only at the write site, because the log is
 * append-only and long-lived: a caller that one day passes a credential blob into
 * `after` would otherwise put a live secret on a screen that four roles can read,
 * and the row cannot be edited afterwards.
 */
function changedFields(before: Prisma.JsonValue | null, after: Prisma.JsonValue | null): string[] {
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()

  const out: string[] = []
  for (const key of keys) {
    if (REDACT.test(key)) {
      out.push(`${key}: [redacted]`)
      continue
    }
    const from = b[key]
    const to = a[key]
    if (JSON.stringify(from) === JSON.stringify(to)) continue

    const show = (v: unknown) =>
      v === undefined || v === null
        ? '—'
        : typeof v === 'object'
          ? JSON.stringify(v).slice(0, 60)
          : String(v).slice(0, 60)

    out.push(Object.keys(b).length ? `${key}: ${show(from)} → ${show(to)}` : `${key}: ${show(to)}`)
  }
  return out.slice(0, 6)
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string; page?: string }>
}) {
  const guard = await pagePermission('audit:read')
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Audit log" />
        <AccessDenied what="The audit log" role={ROLE_LABELS[guard.role]} />
      </>
    )
  }

  const params = await searchParams
  const page = Math.max(1, Number(params.page) || 1)
  const action = params.action
  const entity = params.entity

  const { entries, total, actions, entities } = await withTenant(guard.auth.tenant.id, async () => {
    const where = {
      ...(action ? { action: action as AuditAction } : {}),
      ...(entity ? { entity } : {}),
    }

    const [entries, total, actions, entities] = await Promise.all([
      db().auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      }),
      db().auditLog.count({ where }),
      db().auditLog.groupBy({ by: ['action'], _count: true, orderBy: { action: 'asc' } }),
      db().auditLog.groupBy({ by: ['entity'], _count: true, orderBy: { entity: 'asc' } }),
    ])

    return { entries, total, actions, entities }
  })

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const qs = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    const merged = { action, entity, page: String(page), ...over }
    for (const [k, v] of Object.entries(merged)) if (v && v !== '1') next.set(k, v)
    const s = next.toString()
    return s ? `/admin/audit?${s}` : '/admin/audit'
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, and when. Append-only — entries are never edited or removed, including by an owner."
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <FilterLink href={qs({ action: undefined, page: undefined })} active={!action}>
          All actions
        </FilterLink>
        {actions.map((a) => (
          <FilterLink
            key={a.action}
            href={qs({ action: a.action, page: undefined })}
            active={action === a.action}
          >
            {a.action} ({a._count})
          </FilterLink>
        ))}
      </div>

      {entities.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <FilterLink href={qs({ entity: undefined, page: undefined })} active={!entity}>
            All records
          </FilterLink>
          {entities.map((e) => (
            <FilterLink
              key={e.entity}
              href={qs({ entity: e.entity, page: undefined })}
              active={entity === e.entity}
            >
              {e.entity} ({e._count})
            </FilterLink>
          ))}
        </div>
      )}

      <Card>
        {entries.length === 0 ? (
          <EmptyState
            icon={Shield}
            title={action || entity ? 'Nothing matches that filter' : 'Nothing logged yet'}
            description="Sign-ins, record changes, integration connections and exports are recorded here."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {entries.map((e) => {
              const changes = changedFields(e.before, e.after)
              return (
                <li key={e.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {e.actor ? (
                          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-900">
                            <span className="h-5 w-5 rounded-full bg-brand-100 text-brand-800 grid place-items-center text-[10px] font-semibold">
                              {initials(e.actor.name)}
                            </span>
                            {e.actor.name}
                          </span>
                        ) : (
                          // Not "unknown": jobs act with no user, and saying so is
                          // more useful than implying the actor was lost.
                          <span className="text-sm font-medium text-ink-500">System</span>
                        )}
                        <Badge tone={ACTION_TONE[e.action]}>{e.action}</Badge>
                        <span className="text-sm text-ink-600">{e.entity}</span>
                        {e.entityId && (
                          <code className="text-xs text-ink-400 font-mono">{e.entityId.slice(-8)}</code>
                        )}
                      </div>

                      {changes.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {changes.map((c, i) => (
                            <li key={i} className="text-xs text-ink-500 font-mono">{c}</li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="shrink-0 text-right">
                      <span className="text-xs text-ink-400">{formatRelative(e.createdAt)}</span>
                      {e.ip && <p className="text-xs text-ink-300 font-mono">{e.ip}</p>}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-ink-500">
            {total} {total === 1 ? 'entry' : 'entries'} · page {page} of {pages}
          </p>
          <div className="flex items-center gap-2">
            {page > 1 && (
              <Link
                href={qs({ page: String(page - 1) })}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 transition"
              >
                Newer
              </Link>
            )}
            {page < pages && (
              <Link
                href={qs({ page: String(page + 1) })}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 transition"
              >
                Older
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white'
          : 'rounded-md border border-ink-200 px-2.5 py-1 text-xs text-ink-600 hover:bg-ink-50 transition'
      }
    >
      {children}
    </Link>
  )
}
