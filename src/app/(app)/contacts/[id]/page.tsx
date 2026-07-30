import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge } from '@/components/ui'
import { displayName, formatRelative, formatNumber, initials } from '@/lib/utils'
import { scoreBand, computeScore, daysSince } from '@/lib/leads/scoring'
import { ArrowLeft, Mail, Phone, Linkedin, Building2, MapPin } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const auth = await requirePermission('contact:read')
  const { id } = await params

  const data = await withTenant(auth.tenant.id, async () => {
    const contact = await db().contact.findUnique({
      where: { id },
      include: {
        account: true,
        owner: { select: { name: true, email: true } },
        listMembers: { include: { list: { select: { id: true, name: true } } } },
      },
    })
    if (!contact) return null

    const [activities, scoreEvents, emails, tasks] = await Promise.all([
      db().activity.findMany({
        where: { contactId: id },
        orderBy: { occurredAt: 'desc' },
        take: 25,
      }),
      db().scoreEvent.findMany({
        where: { contactId: id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      db().emailMessage.findMany({
        where: { contactId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      db().task.findMany({
        where: { contactId: id, status: 'open' },
        orderBy: { dueAt: 'asc' },
        take: 10,
      }),
    ])

    const breakdown = computeScore({
      contact,
      account: contact.account,
      signals: {
        opens: emails.reduce((n, e) => n + e.opensCount, 0),
        clicks: emails.reduce((n, e) => n + e.clicksCount, 0),
        replies: emails.filter((e) => e.direction === 'inbound').length,
        formSubmissions: contact.source === 'form' ? 1 : 0,
        daysSinceLastActivity: daysSince(activities[0]?.occurredAt),
      },
    })

    return { contact, activities, scoreEvents, emails, tasks, breakdown }
  })

  if (!data) notFound()

  const { contact, activities, emails, tasks, breakdown } = data
  const band = scoreBand(contact.score)

  return (
    <>
      <Link
        href="/contacts"
        className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to contacts
      </Link>

      <PageHeader
        title={displayName(contact)}
        description={
          [contact.title, contact.account?.name].filter(Boolean).join(' at ') || undefined
        }
        action={
          <div className="flex items-center gap-2">
            <Badge tone={band.tone}>
              {band.label} · {contact.score}
            </Badge>
            <Badge>{contact.status.replace(/_/g, ' ')}</Badge>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: details */}
        <div className="space-y-6">
          <Card>
            <div className="px-5 py-4 border-b border-ink-200 flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-sm font-semibold">
                {initials(displayName(contact))}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-900 truncate">{displayName(contact)}</p>
                <p className="text-xs text-ink-500">
                  Owner: {contact.owner?.name ?? 'Unassigned'}
                </p>
              </div>
            </div>
            <dl className="p-5 space-y-3 text-sm">
              <Field icon={Mail} label="Email">
                {contact.email ? (
                  <span className="inline-flex items-center gap-1.5">
                    <a href={`mailto:${contact.email}`} className="text-brand-700 hover:underline">
                      {contact.email}
                    </a>
                    {contact.emailStatus !== 'unverified' && (
                      <Badge tone={contact.emailStatus === 'valid' ? 'success' : 'warning'}>
                        {contact.emailStatus}
                      </Badge>
                    )}
                  </span>
                ) : '—'}
              </Field>
              <Field icon={Phone} label="Phone">{contact.phone ?? '—'}</Field>
              <Field icon={Linkedin} label="LinkedIn">
                {contact.linkedinUrl ? (
                  <a
                    href={contact.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-700 hover:underline truncate block"
                  >
                    View profile
                  </a>
                ) : '—'}
              </Field>
              <Field icon={Building2} label="Company">
                {contact.account ? (
                  <Link href={`/accounts/${contact.account.id}`} className="text-brand-700 hover:underline">
                    {contact.account.name}
                  </Link>
                ) : '—'}
              </Field>
              <Field icon={MapPin} label="Location">
                {[contact.city, contact.country].filter(Boolean).join(', ') || '—'}
              </Field>
            </dl>
            <div className="px-5 py-3 border-t border-ink-100 text-xs text-ink-500 space-y-1">
              <p>Source: {contact.source ?? 'unknown'}</p>
              <p>Added {formatRelative(contact.createdAt)}</p>
              <p>
                Enriched:{' '}
                {contact.enrichedAt ? formatRelative(contact.enrichedAt) : 'never'}
              </p>
            </div>
          </Card>

          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">Score breakdown</h2>
              <p className="mt-0.5 text-xs text-ink-500">
                Fit {breakdown.fit} · Engagement {breakdown.engagement}
              </p>
            </div>
            {breakdown.applied.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No scoring rules matched yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {breakdown.applied.map((a) => (
                  <li key={a.key} className="px-5 py-2 flex items-center justify-between text-sm">
                    <span className="text-ink-700">{a.label}</span>
                    <span
                      className={
                        a.points >= 0
                          ? 'tabular-nums font-medium text-emerald-600'
                          : 'tabular-nums font-medium text-red-600'
                      }
                    >
                      {a.points > 0 ? '+' : ''}{a.points}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Right: timeline */}
        <div className="lg:col-span-2 space-y-6">
          {tasks.length > 0 && (
            <Card>
              <div className="px-5 py-4 border-b border-ink-200">
                <h2 className="text-sm font-semibold text-ink-900">Open tasks</h2>
              </div>
              <ul className="divide-y divide-ink-100">
                {tasks.map((t) => (
                  <li key={t.id} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink-900">{t.title}</p>
                      <p className="text-xs text-ink-500">{t.type.replace(/_/g, ' ')}</p>
                    </div>
                    <span className="text-xs text-ink-500">{formatRelative(t.dueAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <div className="px-5 py-4 border-b border-ink-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-900">Activity timeline</h2>
              <span className="text-xs text-ink-500">
                {formatNumber(emails.length)} email{emails.length === 1 ? '' : 's'}
              </span>
            </div>
            {activities.length === 0 ? (
              <p className="px-5 py-8 text-sm text-ink-500 text-center">
                Nothing recorded yet. Emails, replies, calls and field changes appear here.
              </p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {activities.map((a) => (
                  <li key={a.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm text-ink-900">{a.summary}</p>
                        <p className="text-xs text-ink-400 mt-0.5">{a.type.replace(/_/g, ' ')}</p>
                      </div>
                      <span className="text-xs text-ink-500 shrink-0">
                        {formatRelative(a.occurredAt)}
                      </span>
                    </div>
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

function Field({
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
