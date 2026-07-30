import Link from 'next/link'
import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, EmptyState } from '@/components/ui'
import { displayName, formatRelative } from '@/lib/utils'
import { Inbox as InboxIcon } from 'lucide-react'

export const metadata = { title: 'Inbox · SalesEngine' }
export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  const auth = await requireAuth()

  const replies = await withTenant(auth.tenant.id, () =>
    db().emailMessage.findMany({
      where: { direction: 'inbound' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        contact: {
          select: {
            id: true, firstName: true, lastName: true, email: true, title: true,
            account: { select: { name: true } },
          },
        },
      },
    })
  )

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Replies to sequenced outreach. A reply stops every active sequence for that contact and their account."
      />

      <Card>
        {replies.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="No replies yet"
            description="Replies detected by the mailbox poller appear here, and each one creates a follow-up task for the record owner."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {replies.map((m) => (
              <li key={m.id} className="px-5 py-4 hover:bg-ink-50/60">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {m.contact ? (
                        <Link
                          href={`/contacts/${m.contact.id}`}
                          className="text-sm font-medium text-ink-900 hover:text-brand-700"
                        >
                          {displayName(m.contact)}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-ink-900">{m.fromEmail}</span>
                      )}
                      {m.contact?.account?.name && (
                        <span className="text-xs text-ink-500">{m.contact.account.name}</span>
                      )}
                      <Badge tone="success">replied</Badge>
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{m.subject}</p>
                    <p className="mt-0.5 text-sm text-ink-500 line-clamp-2">{m.bodyText}</p>
                  </div>
                  <span className="text-xs text-ink-400 shrink-0">
                    {formatRelative(m.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
