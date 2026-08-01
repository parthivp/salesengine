import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { can } from '@/lib/rbac'
import { PageHeader, Card } from '@/components/ui'
import { displayName, formatRelative } from '@/lib/utils'
import { MailView, type MailRow, type Folder } from './client'
import type { ReplyIntent } from '@/lib/email/classify'

export const metadata = { title: 'Inbox · SalesEngine' }
export const dynamic = 'force-dynamic'

type ReplyDetail = {
  intent?: ReplyIntent
  confidence?: number
  reasons?: string[]
  needsReview?: boolean
  messageId?: string
}

/** How many rows one screenful of the list holds. */
const PAGE_SIZE = 200

const FOLDERS: Folder[] = ['replies', 'review', 'other']

function isFolder(v: string | undefined): v is Folder {
  return FOLDERS.includes(v as Folder)
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; page?: string }>
}) {
  const auth = await requireAuth()
  const sp = await searchParams
  const folder: Folder = isFolder(sp.folder) ? sp.folder : 'replies'
  const page = Math.max(1, Number(sp.page) || 1)

  // "Other" is the mail we filed as bulk. Everything else is a real reply; the
  // review folder is a subset of it rather than a separate pile, because a message
  // needing a read is still a reply and must not vanish from the main list.
  const where =
    folder === 'other'
      ? { direction: 'inbound' as const, status: 'filtered' as const }
      : { direction: 'inbound' as const, status: { not: 'filtered' as const } }

  const data = await withTenant(auth.tenant.id, async () => {
    const [messages, totals, pollState] = await Promise.all([
      db().emailMessage.findMany({
        where,
        orderBy: { repliedAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          contact: {
            select: {
              id: true, firstName: true, lastName: true, email: true, title: true,
              account: { select: { name: true } },
            },
          },
          enrollment: { select: { sequence: { select: { name: true } } } },
        },
      }),
      db().emailMessage.groupBy({
        by: ['status'],
        where: { direction: 'inbound' },
        _count: true,
      }),
      db().mailbox.findMany({
        select: { email: true, imapLastPolledAt: true, imapLastError: true, credentials: true },
      }),
    ])

    const contactIds = messages.map((r) => r.contactId).filter((x): x is string => Boolean(x))
    const activities = contactIds.length
      ? await db().activity.findMany({
          where: { type: 'reply', contactId: { in: contactIds } },
          orderBy: { occurredAt: 'desc' },
          select: { detail: true },
          take: 600,
        })
      : []

    return { messages, totals, pollState, activities }
  })

  // The classification lives on the activity the ingest wrote, not on the message:
  // it is a judgement *about* the message, and keeping it separate is what lets a
  // human correction sit beside the machine's original call rather than on top of it.
  const classifications = new Map<string, ReplyDetail>()
  for (const a of data.activities) {
    const d = a.detail as ReplyDetail | null
    if (d?.messageId && !classifications.has(d.messageId)) classifications.set(d.messageId, d)
  }

  const rows: MailRow[] = data.messages.map((m) => {
    const c = classifications.get(m.id)
    return {
      id: m.id,
      subject: m.subject,
      bodyText: m.bodyText ?? '',
      fromEmail: m.fromEmail,
      receivedAt: formatRelative(m.repliedAt ?? m.createdAt),
      intent: c?.intent ?? null,
      confidence: c?.confidence ?? null,
      reasons: c?.reasons ?? [],
      needsReview: c?.needsReview ?? false,
      filtered: m.status === 'filtered',
      contact: m.contact
        ? {
            id: m.contact.id,
            name: displayName(m.contact),
            title: m.contact.title,
            company: m.contact.account?.name ?? null,
          }
        : null,
      sequenceName: m.enrollment?.sequence?.name ?? null,
    }
  })

  const count = (s: string) =>
    data.totals.filter((t) => (s === 'filtered' ? t.status === 'filtered' : t.status !== 'filtered'))
      .reduce((n, t) => n + t._count, 0)

  const totalReplies = count('replies')
  const totalOther = count('filtered')
  const total = folder === 'other' ? totalOther : totalReplies

  // Review is a view over the page in hand rather than a database count: whether a
  // message needs a read is recorded on the activity, not the message, so counting
  // it properly would mean joining every activity in the workspace to answer a
  // number in a tab. The tab says what is on this page, which is what it filters.
  const needsReview = rows.filter((r) => r.needsReview).length

  const polling = data.pollState.filter((m) => {
    const c = m.credentials as { imap?: unknown; graph?: unknown } | null
    return Boolean(c?.imap || c?.graph)
  })
  const pollErrors = polling.filter((m) => m.imapLastError)
  const lastPoll = polling
    .map((m) => m.imapLastPolledAt)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0]

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Replies pulled from your mailboxes and read for intent. Newsletters and notifications are filed under Other rather than counted as replies."
      />

      {/* The most important state this page can be in. Without polling, an empty
          list means "we are not looking", not "nobody replied" — and the sequences
          keep sending regardless. */}
      {polling.length === 0 && (
        <Card className="mb-4 p-4 border-amber-200 bg-amber-50/60">
          <p className="text-sm font-medium text-amber-900">No mailbox is being polled for replies</p>
          <p className="mt-1 text-sm text-amber-800">
            Until one is, sequences cannot tell that someone has written back, and will keep emailing
            people who already replied. Add a mailbox under{' '}
            <a href="/admin/mailboxes" className="underline font-medium">Mailboxes</a>.
          </p>
        </Card>
      )}

      {pollErrors.length > 0 && (
        <Card className="mb-4 p-4 border-red-200 bg-red-50/60">
          <p className="text-sm font-medium text-red-900">
            {pollErrors.length === 1 ? 'A mailbox is' : `${pollErrors.length} mailboxes are`} failing to poll
          </p>
          <ul className="mt-1 space-y-0.5">
            {pollErrors.map((m) => (
              <li key={m.email} className="text-sm text-red-800">
                {m.email} — {m.imapLastError}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <MailView
        rows={rows}
        folder={folder}
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        counts={{ replies: totalReplies, review: needsReview, other: totalOther }}
        canDelete={can(auth.user.role, 'message:delete')}
        lastPoll={lastPoll ? formatRelative(lastPoll) : null}
      />
    </>
  )
}
