import { unseal, type Sealed } from '../crypto'
import { logger } from '../logger'
import type { InboundMessage } from './receive'

/**
 * Microsoft Graph as a reply source.
 *
 * Exists because IMAP is not an option on Microsoft 365 any more. Basic
 * authentication for IMAP is permanently disabled in every Exchange Online
 * tenant, and Microsoft's own documentation says neither you nor Microsoft
 * support can re-enable it. So a username and password — which is all `imap.ts`
 * knows how to do — cannot reach an M365 mailbox at all.
 *
 * Graph replaces the transport, nothing else. Messages are normalised into the
 * same `InboundMessage` and handed to the same `ingestInbound`, so threading,
 * classification and every action on a reply are shared with the IMAP path.
 *
 * Uses the client-credentials flow rather than a delegated one: the poller is a
 * background worker with no user present to complete a sign-in, and a refresh
 * token that expires while nobody is looking is exactly how reply collection
 * dies silently.
 */

const AUTH_HOST = 'https://login.microsoftonline.com'
const GRAPH = 'https://graph.microsoft.com/v1.0'

/** Never pull an unbounded batch on the first sync of an old mailbox. */
const MAX_PER_POLL = 200

/** Stop following nextLink after this many pages in one poll. */
const MAX_PAGES = 10

export type GraphCredentials = {
  /** Entra directory (tenant) id. */
  tenantId: string
  clientId: string
  clientSecret: string
  /** The mailbox to read — UPN or object id. */
  mailbox: string
}

export type GraphFetchResult = {
  messages: InboundMessage[]
  /** Opaque deltaLink to persist and pass to the next poll. */
  deltaLink: string | null
  errors: string[]
}

/**
 * Reads the credential blob off a Mailbox row.
 *
 * Returns null rather than throwing when Graph is not configured — most
 * mailboxes are send-only or use IMAP, and a poller that throws on each of them
 * fills the log with failures that are not failures.
 */
export function graphCredentialsFrom(credentials: unknown): GraphCredentials | null {
  const raw = credentials as Record<string, unknown> | null
  const graph = raw?.graph as Record<string, unknown> | undefined
  if (!graph) return null

  const { tenantId, clientId, mailbox } = graph
  if (typeof tenantId !== 'string' || typeof clientId !== 'string' || typeof mailbox !== 'string') {
    return null
  }

  // A string here means somebody stored the secret in plaintext, which must be
  // refused rather than quietly used.
  const sealed = graph.clientSecret as Sealed | string | undefined
  if (!sealed || typeof sealed !== 'object' || !('ct' in sealed)) {
    logger.error({ tenantId, clientId }, 'Graph client secret is not sealed; refusing to use it')
    return null
  }

  let clientSecret: string
  try {
    clientSecret = unseal(sealed)
  } catch (err) {
    logger.error({ err, clientId }, 'could not decrypt the Graph client secret')
    return null
  }

  return { tenantId, clientId, clientSecret, mailbox }
}

type TokenCacheEntry = { token: string; expiresAt: number }
const tokenCache = new Map<string, TokenCacheEntry>()

/**
 * Client-credentials access token, cached until shortly before it expires.
 *
 * Cached because a token lasts about an hour while the poller runs every few
 * minutes; fetching one per poll is a needless round trip and a needless way to
 * meet a rate limit. The 60-second margin covers clock skew between us and
 * Entra — a token that expires mid-request fails the whole poll.
 */
async function accessToken(creds: GraphCredentials): Promise<string> {
  const key = `${creds.tenantId}:${creds.clientId}`
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })

  const res = await fetch(`${AUTH_HOST}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    // Entra returns the reason in the body, and it is genuinely useful —
    // "invalid_client" versus "unauthorized_client" point at different mistakes.
    // The secret is never in that response, so it is safe to surface.
    throw new Error(`Entra token request failed (${res.status}): ${text.slice(0, 300)}`)
  }

  const json = (await res.json()) as { access_token: string; expires_in: number }
  tokenCache.set(key, {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  })
  return json.access_token
}

type GraphMessage = {
  id: string
  internetMessageId?: string
  conversationId?: string
  subject?: string
  receivedDateTime?: string
  from?: { emailAddress?: { address?: string } }
  toRecipients?: { emailAddress?: { address?: string } }[]
  body?: { contentType?: string; content?: string }
  bodyPreview?: string
  internetMessageHeaders?: { name: string; value: string }[]
  '@removed'?: unknown
}

/**
 * The properties the pipeline needs, and no more.
 *
 * `internetMessageHeaders` is the important one and is *not* returned unless
 * explicitly selected. Without it the classifier loses header-based auto-reply
 * detection and falls back to reading prose — which is how a foreign-language
 * out-of-office starts stopping sequences.
 */
const SELECT = [
  'id',
  'internetMessageId',
  'conversationId',
  'subject',
  'receivedDateTime',
  'from',
  'toRecipients',
  'body',
  'internetMessageHeaders',
].join(',')

function headerMap(headers: GraphMessage['internetMessageHeaders']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers ?? []) {
    if (h?.name) out[h.name.toLowerCase()] = h.value ?? ''
  }
  return out
}

/** Graph returns HTML for most mail; the classifier reads text. */
function toText(body: GraphMessage['body'], fallback: string | undefined): string {
  const content = body?.content ?? ''
  if (!content) return fallback ?? ''
  if ((body?.contentType ?? '').toLowerCase() !== 'html') return content

  return content
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normaliseMessageId(id: string | undefined, graphId: string): string {
  const t = (id ?? '').trim()
  if (!t) return `<graph-${graphId}@salesengine.local>`
  return t.startsWith('<') ? t : `<${t}>`
}

function toInbound(msg: GraphMessage, mailbox: string): InboundMessage {
  const headers = headerMap(msg.internetMessageHeaders)
  return {
    messageId: normaliseMessageId(msg.internetMessageId, msg.id),
    // Graph does not surface In-Reply-To as a first-class field, but it is in the
    // raw headers, which is the same place the IMAP path reads it from.
    inReplyTo: headers['in-reply-to'] ?? null,
    references: (headers['references'] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((r) => (r.startsWith('<') ? r : `<${r}>`)),
    fromEmail: msg.from?.emailAddress?.address ?? '',
    toEmail: msg.toRecipients?.[0]?.emailAddress?.address ?? mailbox,
    subject: msg.subject ?? '(no subject)',
    bodyText: toText(msg.body, msg.bodyPreview),
    bodyHtml: (msg.body?.contentType ?? '').toLowerCase() === 'html' ? msg.body?.content ?? null : null,
    receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
    headers,
  }
}

/**
 * Fetches messages that arrived since the last poll.
 *
 * A delta link replaces the IMAP UID cursor: Microsoft hands back an opaque URL
 * that encodes exactly where the last round finished, so the next poll asks for
 * changes rather than filtering by date. Same reasoning as the UID — a timestamp
 * cursor either re-reads or loses mail whenever clocks disagree.
 *
 * With no cursor, the first poll starts from *now* rather than the beginning of
 * the mailbox. Ingesting years of history would stop sequences on decade-old
 * threads and file hundreds of tasks.
 */
export async function fetchNewMessages(
  creds: GraphCredentials,
  deltaLink: string | null,
  opts: { limit?: number; now?: Date; log?: typeof logger } = {}
): Promise<GraphFetchResult> {
  const log = opts.log ?? logger
  const limit = opts.limit ?? MAX_PER_POLL
  const now = opts.now ?? new Date()
  const token = await accessToken(creds)

  const messages: InboundMessage[] = []
  const errors: string[] = []

  let url =
    deltaLink ??
    `${GRAPH}/users/${encodeURIComponent(creds.mailbox)}/mailFolders/inbox/messages/delta` +
      `?$select=${SELECT}&$filter=receivedDateTime ge ${now.toISOString()}`

  let nextDelta: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const res: Response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        // Ask for the immutable id so a message moved between folders keeps it.
        prefer: 'IdType="ImmutableId"',
      },
    })

    if (!res.ok) {
      const text = await res.text()
      if (res.status === 410) {
        // The delta token expired or was invalidated. Microsoft's documented
        // response is to resync — but starting a *fresh* delta would replay the
        // whole mailbox, so restart from now and accept the small gap rather
        // than flood the inbox with history.
        log.warn('Graph delta token no longer valid; restarting from now')
        return { messages, deltaLink: null, errors: ['delta token expired; resynced from now'] }
      }
      throw new Error(`Graph request failed (${res.status}): ${text.slice(0, 300)}`)
    }

    const json = (await res.json()) as {
      value?: GraphMessage[]
      '@odata.nextLink'?: string
      '@odata.deltaLink'?: string
    }

    for (const msg of json.value ?? []) {
      // Deletions arrive in the same feed, marked. Nothing to ingest.
      if (msg['@removed']) continue
      if (messages.length >= limit) {
        log.warn({ limit }, 'Graph poll hit its batch limit; the rest waits for the next poll')
        break
      }
      try {
        messages.push(toInbound(msg, creds.mailbox))
      } catch (err) {
        // One unreadable message must not stop the batch.
        errors.push(`${msg.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (json['@odata.deltaLink']) {
      nextDelta = json['@odata.deltaLink']
      break
    }
    if (!json['@odata.nextLink'] || messages.length >= limit) {
      // No delta link and no next page: keep the old cursor rather than losing
      // our place, and let the next poll continue.
      nextDelta = deltaLink
      break
    }
    url = json['@odata.nextLink']
  }

  return { messages, deltaLink: nextDelta, errors }
}

/**
 * Confirms the credentials work and the app can actually read that mailbox.
 *
 * Worth its own call because the two failures look nothing alike and need
 * different fixes: a bad secret fails at Entra, while a missing Application
 * Access Policy authenticates fine and then returns 403 on the mailbox.
 */
/**
 * The application permissions Entra actually granted this registration.
 *
 * Read from the `roles` claim of our own access token. Not verified — there is
 * nothing to verify, it is a token we just fetched with our own secret, and the
 * claim is only being used to tell the operator what they consented to.
 *
 * The alternative is finding out at the first send, three days into a campaign,
 * when Graph returns 403 and the mail silently does not go.
 */
export function grantedRoles(token: string): string[] {
  const payload = token.split('.')[1]
  if (!payload) return []
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const roles = (JSON.parse(json) as { roles?: unknown }).roles
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : []
  } catch {
    // A token we cannot decode is not an error worth surfacing — the mailbox
    // check below is the real test. Report nothing rather than claiming nothing
    // was granted.
    return []
  }
}

export type GraphVerification = {
  displayName: string
  /** Granted application permissions, as Entra reports them. */
  roles: string[]
  canRead: boolean
  /** False means sequences from this mailbox will be logged, never sent. */
  canSend: boolean
}

export async function verifyGraphAccess(
  creds: GraphCredentials
): Promise<{ ok: true; result: GraphVerification } | { ok: false; error: string }> {
  let token: string
  try {
    token = await accessToken(creds)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not get a token from Entra.' }
  }

  const res = await fetch(
    `${GRAPH}/users/${encodeURIComponent(creds.mailbox)}?$select=displayName,mail,userPrincipalName`,
    { headers: { authorization: `Bearer ${token}` } }
  )

  if (res.status === 403) {
    return {
      ok: false,
      error:
        'Authenticated, but denied access to that mailbox. Either admin consent has not been granted ' +
        'for Mail.Read, or an Application Access Policy excludes this mailbox.',
    }
  }
  if (res.status === 404) {
    return { ok: false, error: `No mailbox found for "${creds.mailbox}" in that tenant.` }
  }
  if (!res.ok) {
    return { ok: false, error: `Graph returned ${res.status}: ${(await res.text()).slice(0, 200)}` }
  }

  const user = (await res.json()) as { displayName?: string }
  const roles = grantedRoles(token)

  return {
    ok: true,
    result: {
      displayName: user.displayName ?? creds.mailbox,
      roles,
      // Reaching the mailbox at all proves read access, whatever the claim says.
      canRead: true,
      canSend: roles.some((r) => /^Mail\.(Send|ReadWrite)/i.test(r)),
    },
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type GraphSendResult =
  | { ok: true; internetMessageId: string }
  | { ok: false; error: string; retryable: boolean }

/**
 * Retryable failures, deliberately narrow.
 *
 * Throttling and Microsoft's transient service errors are worth another attempt;
 * a rejected recipient, a revoked permission or a bad secret are not, and retrying
 * those burns the outbox's attempt budget while guaranteeing the same answer.
 */
const RETRYABLE_GRAPH = new Set([
  'ApplicationThrottled',
  'ActivityLimitReached',
  'ServiceNotAvailable',
  'ServiceUnavailable',
  'InternalServerError',
  'UnknownError',
  'generalException',
  'quotaLimitReached',
])

/**
 * Sends through the same app registration that reads replies.
 *
 * Why this exists: the only implemented transport was Amazon SES, and every
 * other provider fell through to the logger with a warning — so an operator with
 * Microsoft 365 and no AWS account could configure a mailbox, watch the sequence
 * engine run, and send nothing at all. The warning was in the worker log, which
 * is not where anybody looks to find out why no mail arrived.
 *
 * Graph is the right transport for that operator rather than a fallback. The mail
 * leaves their real mailbox on their real domain, which already has SPF, DKIM and
 * DMARC because Microsoft set them up — no domain to verify, no sandbox to exit,
 * no reputation to build from nothing. It also lands in the Sent Items folder,
 * so the thread reads normally to a human who goes looking for it.
 *
 * **Two calls, not one.** `sendMail` is a single request but returns nothing, and
 * Graph will not let anyone set the `Message-ID` header — `internetMessageHeaders`
 * accepts custom `x-` headers only and rejects the reserved ones. Sending that way
 * would leave the outbox row holding an id that no sent mail carries, so every
 * reply would fail `In-Reply-To` matching and fall back to guessing by address and
 * subject. Creating a draft first returns the id Exchange actually assigned; then
 * we send the draft. The draft also lands in Sent Items on its own, so the thread
 * reads normally to a human who goes looking for it.
 *
 * Threading a *follow-up* onto an existing thread is not solved here, because the
 * engine does not currently send one — every sequence step is a fresh message. It
 * would need `createReply` or an explicit `conversationId`, not a header.
 */
export async function sendViaGraph(
  creds: GraphCredentials,
  message: {
    to: string
    subject: string
    html: string
    text?: string
    /** The id the outbox row was written with, used only if Graph gives us none. */
    messageId: string
    inReplyTo?: string | null
    references?: string | null
    listUnsubscribeUrl?: string | null
    replyTo?: string | null
  }
): Promise<GraphSendResult> {
  let token: string
  try {
    token = await accessToken(creds)
  } catch (err) {
    // A token failure is a configuration problem — an expired secret, consent
    // revoked — and fails identically on retry.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not get a Graph access token',
      retryable: false,
    }
  }

  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const base = `${GRAPH}/users/${encodeURIComponent(creds.mailbox)}`

  // Custom headers only. Graph rejects the reserved ones outright, which is why
  // threading cannot be done through this field — see the note above.
  const headers: { name: string; value: string }[] = []
  if (message.listUnsubscribeUrl) {
    headers.push({ name: 'x-list-unsubscribe', value: `<${message.listUnsubscribeUrl}>` })
    headers.push({ name: 'x-list-unsubscribe-post', value: 'List-Unsubscribe=One-Click' })
  }

  const draftBody = {
    subject: message.subject,
    body: { contentType: 'HTML', content: message.html },
    toRecipients: [{ emailAddress: { address: message.to } }],
    ...(message.replyTo ? { replyTo: [{ emailAddress: { address: message.replyTo } }] } : {}),
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
  }

  // Step 1: create the draft. This is the only response that carries the
  // Message-ID Exchange assigned.
  const created = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(draftBody),
  })

  if (!created.ok) return await graphFailure(created, 'creating the draft')

  const draft = (await created.json()) as { id?: string; internetMessageId?: string }
  if (!draft.id) {
    return { ok: false, error: 'Graph created a draft with no id', retryable: false }
  }

  // Step 2: send it.
  const sent = await fetch(`${base}/messages/${encodeURIComponent(draft.id)}/send`, {
    method: 'POST',
    headers: auth,
  })

  if (sent.status !== 202 && !sent.ok) {
    // The draft is still sitting in the mailbox. Deleting it keeps a retry from
    // leaving a trail of unsent drafts the operator has to clean up by hand.
    await fetch(`${base}/messages/${encodeURIComponent(draft.id)}`, {
      method: 'DELETE',
      headers: auth,
    }).catch(() => {})
    return await graphFailure(sent, 'sending the draft')
  }

  return { ok: true, internetMessageId: draft.internetMessageId ?? message.messageId }
}

/** Turns a Graph error response into an outcome, preserving the reason. */
async function graphFailure(res: Response, what: string): Promise<GraphSendResult> {
  const text = await res.text().catch(() => '')
  let code = ''
  try {
    code = (JSON.parse(text) as { error?: { code?: string } })?.error?.code ?? ''
  } catch {
    // Not JSON. The status alone will have to do.
  }
  return {
    ok: false,
    error: `Graph failed ${what}: ${res.status}${code ? ` (${code})` : ''} ${text.slice(0, 250)}`,
    retryable: res.status === 429 || res.status >= 500 || RETRYABLE_GRAPH.has(code),
  }
}
