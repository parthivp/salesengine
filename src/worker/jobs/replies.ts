import { prismaAdmin } from '../../lib/db'
import { logger } from '../../lib/logger'
import { enqueue } from '../../lib/queue'
import { fetchNewMessages, imapCredentialsFrom } from '../../lib/email/imap'
import { ingestInbound } from '../../lib/email/receive'

/**
 * Reply polling.
 *
 * Two jobs: a fan-out that finds mailboxes worth polling, and a per-mailbox poll.
 * Split so that one unreachable mail server delays one mailbox rather than the
 * whole round — with a single job, the slowest server sets the cadence for
 * everyone, and one that hangs stops replies arriving for every tenant.
 */

/** Don't hammer a server; replies are not real-time and IMAP servers rate-limit. */
const MIN_POLL_INTERVAL_MS = 2 * 60_000

export async function pollDueMailboxes(): Promise<{ queued: number; skipped: number }> {
  const cutoff = new Date(Date.now() - MIN_POLL_INTERVAL_MS)

  // Reads across tenants by necessity — this is the scheduler deciding whose
  // mailbox to poll — so it uses the admin client deliberately, and reads nothing
  // but scheduling columns.
  const mailboxes = await prismaAdmin.mailbox.findMany({
    where: {
      health: { notIn: ['disconnected', 'blocked'] },
      OR: [{ imapLastPolledAt: null }, { imapLastPolledAt: { lt: cutoff } }],
    },
    select: { id: true, tenantId: true, credentials: true },
    take: 500,
  })

  let queued = 0
  let skipped = 0
  for (const mailbox of mailboxes) {
    // Most mailboxes are send-only. Checking here rather than in the poll job
    // keeps the queue free of jobs whose only outcome is "nothing configured".
    if (!imapCredentialsFrom(mailbox.credentials)) {
      skipped++
      continue
    }
    await enqueue('email:poll-replies', { tenantId: mailbox.tenantId, mailboxId: mailbox.id })
    queued++
  }

  if (queued) logger.info({ queued, skipped }, 'reply polls queued')
  return { queued, skipped }
}

export async function pollMailbox(data: {
  tenantId: string
  mailboxId: string
}): Promise<{ fetched: number; ingested: number; duplicates: number; unmatched: number }> {
  const mailbox = await prismaAdmin.mailbox.findUnique({
    where: { id: data.mailboxId },
    select: { id: true, tenantId: true, email: true, credentials: true, imapLastUid: true },
  })
  if (!mailbox) return { fetched: 0, ingested: 0, duplicates: 0, unmatched: 0 }

  const creds = imapCredentialsFrom(mailbox.credentials)
  if (!creds) return { fetched: 0, ingested: 0, duplicates: 0, unmatched: 0 }

  const log = logger.child({ mailboxId: mailbox.id, email: mailbox.email })

  let result
  try {
    result = await fetchNewMessages(creds, mailbox.imapLastUid ?? 0)
  } catch (err) {
    // Record the failure on the row so it is visible in the admin UI rather than
    // only in the log — a mailbox that stopped polling three weeks ago is exactly
    // the thing nobody notices until a deal is lost.
    await prismaAdmin.mailbox.update({
      where: { id: mailbox.id },
      data: {
        imapLastPolledAt: new Date(),
        imapLastError: err instanceof Error ? err.message.slice(0, 500) : 'Unknown IMAP error',
      },
    })
    log.error({ err }, 'IMAP poll failed')
    throw err
  }

  let ingested = 0
  let duplicates = 0
  let unmatched = 0

  for (const msg of result.messages) {
    try {
      const r = await ingestInbound(mailbox.tenantId, msg)
      if (r.ok) ingested++
      else if (r.reason === 'duplicate') duplicates++
      else unmatched++
    } catch (err) {
      // Keep going. One message that fails to ingest must not block the rest of
      // the batch, and the UID cursor still advances — otherwise the poller
      // retries the same message forever and nothing after it is ever read.
      log.error({ err, messageId: msg.messageId }, 'could not ingest an inbound message')
    }
  }

  await prismaAdmin.mailbox.update({
    where: { id: mailbox.id },
    data: {
      imapLastUid: result.highestUid,
      imapLastPolledAt: new Date(),
      imapLastError: result.errors.length ? result.errors.slice(0, 3).join('; ').slice(0, 500) : null,
    },
  })

  if (result.messages.length) {
    log.info(
      { fetched: result.messages.length, ingested, duplicates, unmatched, uid: result.highestUid },
      'mailbox polled'
    )
  }

  return { fetched: result.messages.length, ingested, duplicates, unmatched }
}
