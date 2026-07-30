import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, EmptyState, StatTile } from '@/components/ui'
import { displayName, formatRelative } from '@/lib/utils'
import { Inbox as InboxIcon } from 'lucide-react'
import { ReplyList, type ReplyRow } from './client'
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

export default async function InboxPage() {
  const auth = await requireAuth()

  const { replies, classifications, pollState } = await withTenant(auth.tenant.id, async () => {
    const replies = await db().emailMessage.findMany({
      where: { direction: 'inbound' },
      orderBy: { repliedAt: 'desc' },
      take: 100,
      include: {
        contact: {
          select: {
            id: true, firstName: true, lastName: true, email: true, title: true,
            account: { select: { name: true } },
          },
        },
        enrollment: { select: { sequence: { select: { name: true } } } },
      },
    })

    // The classification lives on the activity the ingest wrote, not on the
    // message: it is a judgement *about* the message, and keeping it separate is
    // what lets a human correction sit beside the machine's original call rather
    // than on top of it.
    const contactIds = replies.map((r) => r.contactId).filter((x): x is string => Boolean(x))
    const activities = contactIds.length
      ? await db().activity.findMany({
          where: { type: 'reply', contactId: { in: contactIds } },
          orderBy: { occurredAt: 'desc' },
          select: { detail: true },
          take: 300,
        })
      : []

    const classifications = new Map<string, ReplyDetail>()
    for (const a of activities) {
      const d = a.detail as ReplyDetail | null
      if (d?.messageId && !classifications.has(d.messageId)) classifications.set(d.messageId, d)
    }

    const mailboxes = await db().mailbox.findMany({
      select: { email: true, imapLastPolledAt: true, imapLastError: true, credentials: true },
    })

    return { replies, classifications, pollState: mailboxes }
  })

  const rows: ReplyRow[] = replies.map((m) => {
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

  const needsReview = rows.filter((r) => r.needsReview).length
  const interested = rows.filter((r) => r.intent === 'interested').length
  const unmatched = rows.filter((r) => !r.contact).length

  const polling = pollState.filter((m) => Boolean((m.credentials as { imap?: unknown } | null)?.imap))
  const pollErrors = polling.filter((m) => m.imapLastError)
  const lastPoll = polling
    .map((m) => m.imapLastPolledAt)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0]

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Replies pulled from your mailboxes and read for intent. A real reply stops the sequence; an out-of-office holds it until they are back."
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
        <StatTile label="Replies" value={String(rows.length)} hint="most recent 100" />
        <StatTile label="Interested" value={String(interested)} tone={interested ? 'positive' : 'neutral'} />
        <StatTile
          label="Needs a read"
          value={String(needsReview)}
          tone={needsReview ? 'warning' : 'neutral'}
          hint={needsReview ? 'the classifier was not confident' : 'nothing ambiguous'}
        />
        <StatTile
          label="Mailboxes polled"
          value={polling.length === 0 ? 'None' : String(polling.length)}
          tone={polling.length === 0 || pollErrors.length ? 'warning' : 'positive'}
          hint={
            polling.length === 0
              ? 'no IMAP configured'
              : pollErrors.length
                ? `${pollErrors.length} failing`
                : lastPoll
                  ? `last ${formatRelative(lastPoll)}`
                  : 'not polled yet'
          }
        />
      </div>

      {/* The most important state this page can be in. Without polling, every
          number above is a zero that means "we are not looking", not "nobody
          replied" — and the sequences keep sending regardless. */}
      {polling.length === 0 && (
        <Card className="mb-6 p-5 border-amber-200 bg-amber-50/60">
          <p className="text-sm font-medium text-amber-900">No mailbox is being polled for replies</p>
          <p className="mt-1 text-sm text-amber-800">
            Until one is, sequences cannot tell that someone has written back, and will keep emailing
            people who already replied. Add IMAP details to a mailbox under{' '}
            <a href="/admin/mailboxes" className="underline font-medium">Mailboxes</a>.
          </p>
        </Card>
      )}

      {pollErrors.length > 0 && (
        <Card className="mb-6 p-5 border-red-200 bg-red-50/60">
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

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="No replies yet"
            description="Replies are pulled from your mailboxes every few minutes, read for intent, and shown here. Anything the classifier is unsure about is flagged for you rather than acted on."
          />
        ) : (
          <>
            {unmatched > 0 && (
              <p className="px-5 py-3 border-b border-ink-100 text-xs text-ink-500">
                {unmatched} {unmatched === 1 ? 'reply is' : 'replies are'} not linked to a contact — kept
                here rather than discarded, so nothing is lost.
              </p>
            )}
            <ReplyList replies={rows} />
          </>
        )}
      </Card>
    </>
  )
}
