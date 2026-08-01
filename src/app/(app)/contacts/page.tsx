import Link from 'next/link'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { ownerFilter, can } from '@/lib/rbac'
import { PageHeader, Card, EmptyState } from '@/components/ui'
import { displayName, formatRelative, formatNumber } from '@/lib/utils'
import { scoreBand } from '@/lib/leads/scoring'
import type { Prisma, ContactStatus } from '@prisma/client'
import { Users, Upload } from 'lucide-react'
import { ContactFilters } from './filters'
import { ContactsTable } from './table'

export const metadata = { title: 'Contacts · SalesEngine' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

const STATUS_TONE: Record<ContactStatus, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  new: 'neutral',
  working: 'brand',
  engaged: 'brand',
  qualified: 'success',
  customer: 'success',
  unqualified: 'neutral',
  do_not_contact: 'danger',
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; owner?: string }>
}) {
  const auth = await requirePermission('contact:read')
  const sp = await searchParams

  const page = Math.max(1, Number(sp.page) || 1)
  const q = sp.q?.trim() ?? ''
  const status = sp.status as ContactStatus | undefined

  const where: Prisma.ContactWhereInput = {
    ...ownerFilter(auth.scope),
    ...(status ? { status } : {}),
    ...(sp.owner === 'me' ? { ownerId: auth.user.id } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { title: { contains: q, mode: 'insensitive' } },
            { account: { name: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const { contacts, total, counts } = await withTenant(auth.tenant.id, async () => {
    const [contacts, total, grouped] = await Promise.all([
      db().contact.findMany({
        where,
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          account: { select: { id: true, name: true, domain: true } },
          owner: { select: { name: true } },
        },
      }),
      db().contact.count({ where }),
      db().contact.groupBy({
        by: ['status'],
        where: ownerFilter(auth.scope),
        _count: { _all: true },
      }),
    ])
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]))
    return { contacts, total, counts }
  })

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <PageHeader
        title="Contacts"
        description={`${formatNumber(total)} ${total === 1 ? 'contact' : 'contacts'} in your view.`}
        action={
          <Link
            href="/contacts/import"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
          >
            <Upload className="h-4 w-4" />
            Import CSV
          </Link>
        }
      />

      <ContactFilters counts={counts} />

      <Card>
        {contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title={q || status ? 'No contacts match those filters' : 'No contacts yet'}
            description={
              q || status
                ? 'Try loosening the search or clearing the status filter.'
                : 'Import a CSV from Apollo, Sales Navigator or your CRM to get started.'
            }
            action={
              !q && !status ? (
                <Link
                  href="/contacts/import"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium hover:bg-ink-50 transition"
                >
                  <Upload className="h-4 w-4" />
                  Import CSV
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <ContactsTable
              canDelete={can(auth.user.role, 'contact:delete')}
              rows={contacts.map((c) => {
                const band = scoreBand(c.score)
                return {
                  id: c.id,
                  name: displayName(c),
                  sub: `${c.title ? `${c.title} · ` : ''}${c.email ?? 'no email'}`,
                  accountId: c.account?.id ?? null,
                  accountName: c.account?.name ?? null,
                  status: c.status.replace(/_/g, ' '),
                  statusTone: STATUS_TONE[c.status],
                  score: c.score,
                  bandLabel: band.label,
                  bandTone: band.tone,
                  owner: c.owner?.name ?? 'Unassigned',
                  added: formatRelative(c.createdAt),
                }
              })}
            />

            {pages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-ink-100 text-sm">
                <p className="text-ink-500">
                  Page {page} of {pages}
                </p>
                <div className="flex gap-2">
                  <PageLink page={page - 1} disabled={page <= 1} sp={sp}>
                    Previous
                  </PageLink>
                  <PageLink page={page + 1} disabled={page >= pages} sp={sp}>
                    Next
                  </PageLink>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}

function PageLink({
  page,
  disabled,
  sp,
  children,
}: {
  page: number
  disabled: boolean
  sp: Record<string, string | undefined>
  children: React.ReactNode
}) {
  if (disabled) {
    return (
      <span className="rounded-md border border-ink-200 px-2.5 py-1 text-ink-300 cursor-not-allowed">
        {children}
      </span>
    )
  }
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) if (v && k !== 'page') params.set(k, v)
  params.set('page', String(page))
  return (
    <Link
      href={`/contacts?${params}`}
      className="rounded-md border border-ink-200 px-2.5 py-1 hover:bg-ink-50 transition"
    >
      {children}
    </Link>
  )
}
