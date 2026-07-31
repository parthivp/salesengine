import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendViaGraph, type GraphCredentials } from '../email/graph'

/**
 * Graph sending, against a stubbed fetch.
 *
 * The behaviour worth pinning is the two-call shape: a one-shot `sendMail`
 * returns no Message-ID, and without one every reply to this message fails
 * thread matching.
 */

const CREDS: GraphCredentials = {
  tenantId: 'dir-1', clientId: 'app-1', clientSecret: 'secret', mailbox: 'sales@acme.test',
}

const MESSAGE = {
  to: 'borong@zhonglun.com',
  subject: 'Quick question',
  html: '<p>Hello</p>',
  text: 'Hello',
  messageId: '<ours@salesengine.local>',
  listUnsubscribeUrl: 'https://app.test/u/abc',
}

let calls: { url: string; method: string; body?: unknown }[] = []

function bodyAsJson(body: unknown): unknown {
  if (typeof body !== 'string' || !body.trimStart().startsWith('{')) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function stub(handlers: ((url: string, init: RequestInit) => Response | null)[]) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      // The token request posts form-encoded data, not JSON — parsing it
      // unconditionally threw inside the stub and every call looked like a
      // Graph failure.
      body: bodyAsJson(init.body),
    })
    // Token endpoint first, always.
    if (String(url).includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: `t${calls.length}`, expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    for (const h of handlers) {
      const r = h(String(url), init)
      if (r) return r
    }
    return new Response('unexpected', { status: 500 })
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => { calls = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('sending through Graph', () => {
  it('creates a draft, sends it, and returns the id Exchange assigned', async () => {
    stub([
      (url, init) =>
        url.endsWith('/messages') && init.method === 'POST'
          ? json({ id: 'draft-1', internetMessageId: '<real@exchange>' })
          : null,
      (url, init) =>
        url.endsWith('/messages/draft-1/send') && init.method === 'POST'
          ? new Response(null, { status: 202 })
          : null,
    ])

    const r = await sendViaGraph(CREDS, MESSAGE)
    expect(r).toEqual({ ok: true, internetMessageId: '<real@exchange>' })

    // Not our generated id — the one the provider stamped on the mail. Storing
    // ours would break In-Reply-To matching for every reply.
    expect(r.ok && r.internetMessageId).not.toBe(MESSAGE.messageId)

    const posts = calls.filter((c) => c.method === 'POST' && !c.url.includes('oauth2'))
    expect(posts).toHaveLength(2)
    expect(posts[0].url).toContain('/users/sales%40acme.test/messages')
  })

  it('sets one-click unsubscribe as a custom header', async () => {
    // Graph rejects reserved header names outright, so these have to be x-prefixed.
    stub([
      (url, init) => (url.endsWith('/messages') && init.method === 'POST'
        ? json({ id: 'd', internetMessageId: '<x@y>' }) : null),
      (url) => (url.endsWith('/send') ? new Response(null, { status: 202 }) : null),
    ])
    await sendViaGraph(CREDS, MESSAGE)
    const draft = calls.find((c) => c.url.endsWith('/messages'))!.body as {
      internetMessageHeaders: { name: string }[]
    }
    expect(draft.internetMessageHeaders.map((h) => h.name)).toEqual([
      'x-list-unsubscribe', 'x-list-unsubscribe-post',
    ])
  })

  it('deletes the draft when sending fails, so retries do not pile up', async () => {
    stub([
      (url, init) => (url.endsWith('/messages') && init.method === 'POST'
        ? json({ id: 'draft-9', internetMessageId: '<x@y>' }) : null),
      (url) => (url.endsWith('/send') ? json({ error: { code: 'ErrorInvalidRecipients' } }, 400) : null),
      (url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : null),
    ])

    const r = await sendViaGraph(CREDS, MESSAGE)
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('draft-9'))).toBe(true)
  })

  it('marks throttling retryable and a bad recipient not', async () => {
    for (const [status, code, retryable] of [
      [429, 'ApplicationThrottled', true],
      [503, 'ServiceNotAvailable', true],
      [400, 'ErrorInvalidRecipients', false],
      [403, 'ErrorAccessDenied', false],
    ] as const) {
      calls = []
      stub([(url) => (url.endsWith('/messages') ? json({ error: { code } }, status) : null)])
      const r = await sendViaGraph(CREDS, MESSAGE)
      expect(r.ok, code).toBe(false)
      expect(!r.ok && r.retryable, code).toBe(retryable)
    }
  })

  it('does not retry a token failure', async () => {
    // An expired secret or revoked consent fails identically next time.
    vi.stubGlobal('fetch', async () => new Response('{"error":"invalid_client"}', { status: 401 }))
    const r = await sendViaGraph(CREDS, MESSAGE)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryable).toBe(false)
  })

  it('falls back to our own id if Graph returns none', async () => {
    stub([
      (url, init) => (url.endsWith('/messages') && init.method === 'POST' ? json({ id: 'd' }) : null),
      (url) => (url.endsWith('/send') ? new Response(null, { status: 202 }) : null),
    ])
    const r = await sendViaGraph(CREDS, MESSAGE)
    expect(r).toEqual({ ok: true, internetMessageId: MESSAGE.messageId })
  })
})

describe('choosing a transport', () => {
  it('prefers Graph credentials over the provider label', async () => {
    // The label is a category; an app registration on the row is a statement
    // about how this specific mailbox works.
    const { resolveTransport } = await import('../email/send')
    const { seal } = await import('../crypto')
    const credentials = {
      graph: {
        tenantId: 'dir-1', clientId: 'app-1', mailbox: 'sales@acme.test',
        clientSecret: seal('secret'),
      },
    }
    expect(resolveTransport('outlook', credentials).key).toBe('graph')
    expect(resolveTransport('smtp', credentials).key).toBe('graph')
  })

  it('logs rather than substituting a different sender', async () => {
    // Falling back to SES for a mailbox that cannot send would put someone
    // else's address in the From line, which is worse than not sending.
    const { resolveTransport } = await import('../email/send')
    expect(resolveTransport('outlook').key).toBe('log')
    expect(resolveTransport('smtp', {}).key).toBe('log')
  })

  it('the kill switch beats a perfectly good mailbox', async () => {
    // The suite runs with EMAIL_TRANSPORT=log, so this is the real guarantee
    // that no test can ever send mail to a real person.
    const { transportFor } = await import('../email/send')
    const { seal } = await import('../crypto')
    const credentials = {
      graph: {
        tenantId: 'd', clientId: 'c', mailbox: 'sales@acme.test', clientSecret: seal('s'),
      },
    }
    expect(transportFor('outlook', credentials).key).toBe('log')
  })
})
