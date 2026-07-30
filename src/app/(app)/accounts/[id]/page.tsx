import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, EmptyState } from '@/components/ui'
import { displayName, formatNumber, formatRelative } from '@/lib/utils'
import { scoreBand } from '@/lib/leads/scoring'
import { ArrowLeft, Globe, Linkedin, MapPin, Users, Briefcase } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const auth = await requirePermission('account:read')
  const { id } = await params

  const data = await withTenant(auth.tenant.id, async () => {
    const account = await db().account.findUnique({
      where: { id },
      include: { owner: { select: { name: true } } },
    })
    if (!account) return null

    const [contacts, activities] = await Promise.all([
      db().contact.findMany({
        where: { accountId: id },
        orderBy: { score: 'desc' },
        take: 50,
      }),
      db().activity.findMany({
        where: { accountId: id },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      }),
    ])
    return { account, contacts, activities }
  })

  if (!data) notFound()
  const { account, contacts, activities } = data

  return (
    <>
      <Link
        href="/accounts"
        className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to accounts
      </Link>

      <PageHeader
        title={account.name}
        description={account.industry ?? undefined}
        action={<Badge>{contacts.length} contact{contacts.length === 1 ? '' : 's'}</Badge>}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="h-fit">
          <div className="px-5 py-4 border-b border-ink-200">
            <h2 className="text-sm font-semibold text-ink-900">Company</h2>
          </div>
          <dl className="p-5 space-y-3 text-sm">
            <Row icon={Globe} label="Domain">
              {account.domain ? (
                <a
                  href={`https://${account.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-700 hover:underline"
                >
                  {account.domain}
                </a>
              ) : '—'}
            </Row>
            <Row icon={Users} label="Employees">
              {account.employeeCount ? formatNumber(account.employeeCount) : '—'}
            </Row>
            <Row icon={Briefcase} label="Revenue">
              {account.annualRevenue
                ? `$${formatNumber(Number(account.annualRevenue))}`
                : '—'}
            </Row>
            <Row icon={MapPin} label="Location">
              {[account.city, account.country].filter(Boolean).join(', ') || '—'}
            </Row>
            <Row icon={Linkedin} label="LinkedIn">
              {account.linkedinUrl ? (
                <a
                  href={account.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-700 hover:underline"
                >
                  View company
                </a>
              ) : '—'}
            </Row>
          </dl>
          {account.description && (
            <p className="px-5 pb-4 text-sm text-ink-600 leading-relaxed">{account.description}</p>
          )}
          <div className="px-5 py-3 border-t border-ink-100 text-xs text-ink-500 space-y-1">
            <p>Owner: {account.owner?.name ?? 'Unassigned'}</p>
            <p>Added {formatRelative(account.createdAt)}</p>
            <p>Enriched: {account.enrichedAt ? formatRelative(account.enrichedAt) : 'never'}</p>
          </div>
        </Card>

        <div className="lg:col-span-2 space-y-6">
          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">People</h2>
            </div>
            {contacts.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No contacts at this company yet"
                description="Import contacts with this domain and they will attach here automatically."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {contacts.map((c) => {
                  const band = scoreBand(c.score)
                  return (
                    <li key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
                      <Link href={`/contacts/${c.id}`} className="min-w-0 group">
                        <p className="text-sm font-medium text-ink-900 group-hover:text-brand-700 truncate">
                          {displayName(c)}
                        </p>
                        <p className="text-xs text-ink-500 truncate">
                          {c.title ?? c.email ?? '—'}
                        </p>
                      </Link>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm tabular-nums text-ink-700">{c.score}</span>
                        <Badge tone={band.tone}>{band.label}</Badge>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">Account activity</h2>
            </div>
            {activities.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-500">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {activities.map((a) => (
                  <li key={a.id} className="px-5 py-3 flex items-start justify-between gap-4">
                    <p className="text-sm text-ink-900">{a.summary}</p>
                    <span className="text-xs text-ink-500 shrink-0">
                      {formatRelative(a.occurredAt)}
                    </span>
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

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="h-4 w-4 mt-0.5 text-ink-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-ink-500">{label}</dt>
        <dd className="text-ink-900 truncate">{children}</dd>
      </div>
    </div>
  )
}
