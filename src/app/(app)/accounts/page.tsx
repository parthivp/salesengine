import Link from 'next/link'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { ownerFilter } from '@/lib/rbac'
import { PageHeader, Card, EmptyState, Badge } from '@/components/ui'
import { formatNumber, formatRelative } from '@/lib/utils'
import { Building2 } from 'lucide-react'
import type { Prisma } from '@prisma/client'

export const metadata = { title: 'Accounts · SalesEngine' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  const auth = await requirePermission('account:read')
  const sp = await searchParams
  const page = Math.max(1, Number(sp.page) || 1)
  const q = sp.q?.trim() ?? ''

  const where: Prisma.AccountWhereInput = {
    ...ownerFilter(auth.scope),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { domain: { contains: q, mode: 'insensitive' } },
            { industry: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const { accounts, total } = await withTenant(auth.tenant.id, async () => {
    const [accounts, total] = await Promise.all([
      db().account.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          owner: { select: { name: true } },
          _count: { select: { contacts: true, deals: true } },
        },
      }),
      db().account.count({ where }),
    ])
    return { accounts, total }
  })

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <PageHeader
        title="Accounts"
        description={`${formatNumber(total)} ${total === 1 ? 'company' : 'companies'} in your view.`}
      />

      <form className="mb-4 max-w-sm">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search company or domain"
          aria-label="Search accounts"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
        />
      </form>

      <Card>
        {accounts.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={q ? 'No accounts match that search' : 'No accounts yet'}
            description={
              q
                ? 'Try a different company name or domain.'
                : 'Accounts are created automatically when you import contacts with a company domain.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
                    <th className="px-5 py-2.5 font-medium">Company</th>
                    <th className="px-5 py-2.5 font-medium">Industry</th>
                    <th className="px-5 py-2.5 font-medium">Employees</th>
                    <th className="px-5 py-2.5 font-medium">Contacts</th>
                    <th className="px-5 py-2.5 font-medium">Owner</th>
                    <th className="px-5 py-2.5 font-medium">Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {accounts.map((a) => (
                    <tr key={a.id} className="hover:bg-ink-50/60">
                      <td className="px-5 py-3">
                        <Link href={`/accounts/${a.id}`} className="group block">
                          <p className="font-medium text-ink-900 group-hover:text-brand-700 truncate">
                            {a.name}
                          </p>
                          {a.domain && <p className="text-xs text-ink-500">{a.domain}</p>}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-ink-600">{a.industry ?? '—'}</td>
                      <td className="px-5 py-3 text-ink-600 tabular-nums">
                        {a.employeeCount ? formatNumber(a.employeeCount) : '—'}
                      </td>
                      <td className="px-5 py-3">
                        <Badge>{a._count.contacts}</Badge>
                      </td>
                      <td className="px-5 py-3 text-ink-600">{a.owner?.name ?? 'Unassigned'}</td>
                      <td className="px-5 py-3 text-ink-500">{formatRelative(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-ink-100 text-sm">
                <p className="text-ink-500">Page {page} of {pages}</p>
                <div className="flex gap-2">
                  {page > 1 && (
                    <Link
                      href={`/accounts?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page - 1) })}`}
                      className="rounded-md border border-ink-200 px-2.5 py-1 hover:bg-ink-50"
                    >
                      Previous
                    </Link>
                  )}
                  {page < pages && (
                    <Link
                      href={`/accounts?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page + 1) })}`}
                      className="rounded-md border border-ink-200 px-2.5 py-1 hover:bg-ink-50"
                    >
                      Next
                    </Link>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}
