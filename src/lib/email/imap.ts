import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { unseal, type Sealed } from '../crypto'
import { logger } from '../logger'
import type { InboundMessage } from './receive'

/**
 * IMAP polling.
 *
 * Chosen as the primary reply path because it is the one that works with the
 * mailbox a salesperson already has. An SES inbound rule needs a dedicated domain
 * and MX records pointed at AWS; Gmail push needs a Google Cloud project and a
 * Pub/Sub topic. IMAP needs a password. For a team that wants replies to arrive
 * today, in the mailbox they already send from, that difference is the whole
 * decision.
 *
 * Everything here is transport. What a reply *means* lives in `classify.ts`, and
 * what to do about it in `receive.ts`, so a second provider is a new file next to
 * this one and nothing else changes.
 */

export type ImapCredentials = {
  host: string
  port?: number
  secure?: boolean
  user: string
  /** Encrypted at rest; `unseal`ed here and never logged. */
  password: string
  /** Folder to read. INBOX unless the account files replies elsewhere. */
  mailbox?: string
}

export type ImapFetchResult = {
  messages: InboundMessage[]
  /** Highest UID seen, to be persisted as the next poll's starting point. */
  highestUid: number
  errors: string[]
}

/** Never pull an unbounded batch — a first connection to an old mailbox is huge. */
const MAX_PER_POLL = 200

/**
 * Reads the credential blob off a Mailbox row.
 *
 * Returns null rather than throwing when IMAP is not configured: most mailboxes
 * are send-only, and a poller that throws on each of them fills the log with
 * failures that are not failures.
 */
export function imapCredentialsFrom(credentials: unknown): ImapCredentials | null {
  const raw = credentials as Record<string, unknown> | null
  const imap = raw?.imap as Record<string, unknown> | undefined
  if (!imap || typeof imap.host !== 'string' || typeof imap.user !== 'string') return null

  // `seal` returns an object, not a string — a string here means somebody stored
  // the password in plaintext, which must be refused rather than quietly used.
  const sealed = imap.password as Sealed | string | undefined
  if (!sealed || typeof sealed !== 'object' || !('ct' in sealed)) {
    logger.error({ host: imap.host }, 'IMAP password is not sealed; refusing to use it')
    return null
  }

  let password: string
  try {
    password = unseal(sealed)
  } catch (err) {
    logger.error({ err, host: imap.host }, 'could not decrypt IMAP password')
    return null
  }

  return {
    host: imap.host,
    port: typeof imap.port === 'number' ? imap.port : 993,
    secure: imap.secure !== false,
    user: imap.user,
    password,
    mailbox: typeof imap.mailbox === 'string' ? imap.mailbox : 'INBOX',
  }
}

function headerMap(headers: Map<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [key, value] of headers) {
    out[key.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value)
  }
  return out
}

/** Message-ID / In-Reply-To arrive with or without angle brackets depending on client. */
function normaliseMessageId(id: string | undefined | null): string | null {
  if (!id) return null
  const t = id.trim()
  if (!t) return null
  return t.startsWith('<') ? t : `<${t}>`
}

/**
 * Fetches messages newer than `sinceUid`.
 *
 * UID-based rather than date-based on purpose. Dates are the obvious choice and
 * the wrong one: server clocks drift, a message that arrives during a poll can
 * carry a timestamp just before the cursor, and `SINCE` has one-day granularity in
 * IMAP — so a date cursor either re-reads a whole day every poll or loses mail.
 * UIDs are monotonic per folder and exist for this.
 */
export async function fetchNewMessages(
  creds: ImapCredentials,
  sinceUid: number,
  opts: { limit?: number; logger?: typeof logger } = {}
): Promise<ImapFetchResult> {
  const log = opts.logger ?? logger
  const limit = opts.limit ?? MAX_PER_POLL
  const messages: InboundMessage[] = []
  const errors: string[] = []
  let highestUid = sinceUid

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port ?? 993,
    secure: creds.secure ?? true,
    auth: { user: creds.user, pass: creds.password },
    // The library logs the full IMAP conversation at info level by default, which
    // includes the AUTHENTICATE line.
    logger: false,
  })

  await client.connect()
  try {
    const lock = await client.getMailboxLock(creds.mailbox ?? 'INBOX')
    try {
      // `${n}:*` always returns at least one message even when none are newer —
      // IMAP clamps the range — so the cursor comparison below is what actually
      // filters, not the range.
      const range = `${sinceUid + 1}:*`

      for await (const msg of client.fetch(range, { uid: true, source: true, envelope: true }, { uid: true })) {
        if (msg.uid <= sinceUid) continue
        if (messages.length >= limit) {
          log.warn({ limit, uid: msg.uid }, 'IMAP poll hit its batch limit; remaining mail waits for the next poll')
          break
        }

        highestUid = Math.max(highestUid, msg.uid)

        if (!msg.source) {
          errors.push(`uid ${msg.uid}: server returned no source`)
          continue
        }

        try {
          // `simpleParser` is overloaded and the callback form returns void, so
          // TypeScript resolves the union to `void & Promise<ParsedMail>` unless
          // the promise form is named explicitly.
          const parsed: ParsedMail = await simpleParser(msg.source)
          const messageId = normaliseMessageId(parsed.messageId) ?? `<imap-${creds.user}-${msg.uid}@local>`
          const from = parsed.from?.value?.[0]?.address ?? ''
          const to = parsed.to
            ? (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to).value?.[0]?.address ?? creds.user
            : creds.user

          const references = parsed.references
            ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
                .map((r) => normaliseMessageId(r))
                .filter((r): r is string => Boolean(r))
            : []

          messages.push({
            messageId,
            inReplyTo: normaliseMessageId(parsed.inReplyTo),
            references,
            fromEmail: from,
            toEmail: to,
            subject: parsed.subject ?? '(no subject)',
            bodyText: parsed.text ?? '',
            bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
            receivedAt: parsed.date ?? new Date(),
            headers: headerMap(parsed.headers as Map<string, unknown>),
          })
        } catch (err) {
          // One unparseable message must not stop the batch, but the UID cursor
          // has already advanced past it — otherwise the poller retries the same
          // broken message forever and no mail after it is ever read.
          const reason = err instanceof Error ? err.message : String(err)
          errors.push(`uid ${msg.uid}: ${reason}`)
          log.error({ err, uid: msg.uid }, 'could not parse an IMAP message; skipping it')
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => client.close())
  }

  return { messages, highestUid, errors }
}
