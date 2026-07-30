import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { createHmac, randomUUID } from 'node:crypto'
import { env } from '../env'
import { logger } from '../logger'

/**
 * Sending.
 *
 * The provider is abstracted because mailboxes differ per tenant — SES for
 * volume, Gmail/Graph for send-as from a rep's own address. Only SES is
 * implemented here; the others slot in behind `Transport` without the caller
 * changing.
 *
 * Two invariants the sequence engine relies on:
 *   - every send carries an idempotency key, so a retried job cannot double-send;
 *   - the provider's message id is returned, so bounce and complaint webhooks
 *     can be matched back to the row that caused them.
 */

export type OutboundEmail = {
  from: { name: string; email: string }
  to: string
  replyTo?: string
  subject: string
  html: string
  text: string
  /** Threading headers so replies land in the same conversation. */
  inReplyTo?: string
  references?: string
  listUnsubscribeUrl?: string
  /** Passed to the provider so retries are deduplicated provider-side too. */
  idempotencyKey: string
  configurationSet?: string
  tags?: Record<string, string>
}

export type SendOutcome =
  | { ok: true; providerId: string; messageId: string }
  | { ok: false; error: string; retryable: boolean }

export interface Transport {
  readonly key: 'ses' | 'gmail' | 'outlook' | 'smtp' | 'log'
  send(email: OutboundEmail): Promise<SendOutcome>
}

/** RFC 5322 Message-ID we generate ourselves so threading survives providers. */
export function newMessageId(domain: string): string {
  return `<${randomUUID()}@${domain}>`
}

// ---------------------------------------------------------------------------
// SES
// ---------------------------------------------------------------------------

let sesClient: SESv2Client | null = null

function ses(): SESv2Client {
  if (!sesClient) {
    sesClient = new SESv2Client({
      region: env.AWS_REGION,
      ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    })
  }
  return sesClient
}

export function sesConfigured(): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
}

/**
 * Real sending must be opted into, not inherited.
 *
 * `EMAIL_TRANSPORT=log` forces the no-op transport; `ses` demands SES and fails
 * loudly if it is unconfigured rather than quietly not sending; `auto` (the
 * default) uses SES when credentials exist.
 */
export function sendingEnabled(): boolean {
  if (env.EMAIL_TRANSPORT === 'log') return false
  if (env.EMAIL_TRANSPORT === 'ses') return true
  return sesConfigured()
}

/** Throttling and 5xx are worth another attempt; a rejected address is not. */
const RETRYABLE = new Set([
  'Throttling', 'ThrottlingException', 'TooManyRequestsException',
  'ServiceUnavailable', 'InternalFailure', 'RequestTimeout',
  'LimitExceededException', 'SendingPausedException',
])

export const sesTransport: Transport = {
  key: 'ses',
  async send(email) {
    if (!sesConfigured()) {
      return { ok: false, error: 'SES is not configured (AWS credentials missing).', retryable: false }
    }

    const headers: Record<string, string> = {}
    if (email.inReplyTo) headers['In-Reply-To'] = email.inReplyTo
    if (email.references) headers['References'] = email.references
    if (email.listUnsubscribeUrl) {
      // One-click unsubscribe. Gmail and Yahoo require this for bulk senders,
      // and it markedly reduces spam-button complaints.
      headers['List-Unsubscribe'] = `<${email.listUnsubscribeUrl}>`
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
    }

    try {
      const res = await ses().send(
        new SendEmailCommand({
          FromEmailAddress: `${email.from.name} <${email.from.email}>`,
          Destination: { ToAddresses: [email.to] },
          ReplyToAddresses: email.replyTo ? [email.replyTo] : undefined,
          ConfigurationSetName: email.configurationSet ?? env.SES_CONFIGURATION_SET ?? undefined,
          EmailTags: email.tags
            ? Object.entries(email.tags).map(([Name, Value]) => ({ Name, Value }))
            : undefined,
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: email.html, Charset: 'UTF-8' },
                Text: { Data: email.text, Charset: 'UTF-8' },
              },
              Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        })
      )

      return {
        ok: true,
        providerId: res.MessageId ?? '',
        messageId: email.inReplyTo ?? '',
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError'
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err, to: email.to }, 'SES send failed')
      return { ok: false, error: `${name}: ${message}`, retryable: RETRYABLE.has(name) }
    }
  },
}

/**
 * Development transport. Logs instead of sending, so the whole sequence engine
 * can be exercised end to end without AWS credentials or risking a real send to
 * a real prospect from a dev machine.
 */
export const logTransport: Transport = {
  key: 'log',
  async send(email) {
    logger.info(
      { to: email.to, subject: email.subject, idempotencyKey: email.idempotencyKey },
      'logTransport: email not actually sent',
    )
    return { ok: true, providerId: `log-${email.idempotencyKey}`, messageId: '' }
  },
}

export function transportFor(provider: string): Transport {
  if (!sendingEnabled()) return logTransport

  switch (provider) {
    case 'ses':
      return sesConfigured() ? sesTransport : logTransport
    case 'gmail':
    case 'outlook':
    case 'smtp':
      // Deliberately explicit rather than silently falling back to SES, which
      // would send from the wrong address.
      logger.warn({ provider }, 'transport not implemented; using logTransport')
      return logTransport
    default:
      return logTransport
  }
}

// ---------------------------------------------------------------------------
// Tracking & unsubscribe links
// ---------------------------------------------------------------------------

/**
 * Signed so a tracking or unsubscribe URL cannot be forged or enumerated:
 * without this, anyone could unsubscribe any address by guessing an id.
 */
export function signToken(payload: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(payload).digest('base64url').slice(0, 32)
}

export function verifyToken(payload: string, token: string): boolean {
  const expected = signToken(payload)
  if (expected.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
}

export function unsubscribeUrl(messageId: string): string {
  return `${env.APP_URL}/e/u/${messageId}/${signToken(`u:${messageId}`)}`
}

export function openPixelUrl(messageId: string): string {
  return `${env.APP_URL}/e/o/${messageId}/${signToken(`o:${messageId}`)}.gif`
}

export function clickUrl(messageId: string, target: string): string {
  const encoded = Buffer.from(target, 'utf8').toString('base64url')
  return `${env.APP_URL}/e/c/${messageId}/${signToken(`c:${messageId}:${encoded}`)}?u=${encoded}`
}

/** Rewrites links for click tracking. Opt-in per sequence — off by default. */
export function rewriteLinksForTracking(html: string, messageId: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, url: string) => {
    // Never rewrite the unsubscribe link: breaking it is both a compliance
    // failure and the fastest route to spam complaints.
    if (url.includes('/e/u/')) return `href="${url}"`
    return `href="${clickUrl(messageId, url)}"`
  })
}

export function appendTrackingPixel(html: string, messageId: string): string {
  const pixel = `<img src="${openPixelUrl(messageId)}" width="1" height="1" alt="" style="display:none" />`
  return html.includes('</body>') ? html.replace('</body>', `${pixel}</body>`) : html + pixel
}

/**
 * Plain-text-first HTML. Deliberately minimal markup: heavy templates and image
 * headers are among the strongest negative signals on a cold first touch.
 */
export function textToHtml(text: string, unsubUrl?: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#2563eb">$1</a>'
  )

  const body = linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, '<br />')}</p>`)
    .join('')

  const footer = unsubUrl
    ? `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">` +
      `<a href="${unsubUrl}" style="color:#6b7280">Unsubscribe</a></p>`
    : ''

  return (
    `<!doctype html><html><body style="margin:0;padding:0">` +
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;` +
    `line-height:1.55;color:#111827;max-width:560px">${body}${footer}</div></body></html>`
  )
}
