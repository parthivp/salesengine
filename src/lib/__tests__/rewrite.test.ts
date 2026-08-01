import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// `env` parses process.env once at import, so setting a variable inside a test
// would have no effect on the module under test. Mocked instead.
const fakeEnv = {
  OPENAI_API_KEY: 'sk-test' as string | undefined,
  OPENAI_MODEL: 'gpt-4o-mini',
  // The logger reads NODE_ENV off the same object at import time.
  NODE_ENV: 'test',
}
vi.mock('../env', () => ({ env: fakeEnv, isProd: false, isDev: false, isTest: true }))

const { rewriteDraft, unsupportedClaims } = await import('../ai/rewrite')
type RewriteRequest = Parameters<typeof rewriteDraft>[0]

/**
 * The rewrite path, against a stubbed OpenAI.
 *
 * What matters here is not prose quality — that is not testable — but the
 * guardrails: what the model is allowed to see, what happens when it ignores an
 * instruction, and whether a failure is worth retrying.
 */

const BASE = {
  kind: 'connect' as const,
  rough: 'we build legal software, saw you run court reporting, want to show you what we did',
  limit: 300,
  facts: { firstName: 'Andrew', title: 'Founder', company: 'DepoStack', industry: 'Legal services' },
  senderName: 'Parthiv',
}

let sent: { body: Record<string, unknown> } | null = null

function stubOpenAI(content: unknown, status = 200) {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent = { body: JSON.parse(String(init.body)) }
    if (status !== 200) return new Response(String(content), { status })
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  })
}

beforeEach(() => { sent = null; fakeEnv.OPENAI_API_KEY = 'sk-test' })
afterEach(() => { vi.unstubAllGlobals() })

describe('rewriting a draft', () => {
  it('returns the rewritten text', async () => {
    stubOpenAI({ text: 'Hi Andrew — we build software for legal teams. Worth connecting.' })
    const r = await rewriteDraft(BASE)
    expect(r.ok).toBe(true)
    expect(r.ok && r.text).toContain('Andrew')
  })

  it('shows the model only the facts it was given', async () => {
    stubOpenAI({ text: 'ok' })
    await rewriteDraft({ ...BASE, facts: { firstName: 'Andrew', company: 'DepoStack' } })
    const messages = (sent!.body.messages as { role: string; content: string }[])
    const user = messages.find((m) => m.role === 'user')!.content

    expect(user).toContain('DepoStack')
    // Fields that were absent must not appear as empty labels — a blank
    // "Their industry:" invites the model to fill it in.
    expect(user).not.toContain('Their industry')
    expect(user).not.toContain('Company headcount')
  })

  it('tells the model what was already sent to this person', async () => {
    stubOpenAI({ text: 'ok' })
    await rewriteDraft({ ...BASE, priorToContact: ['Hi Andrew — worth connecting.'] })
    const user = ((sent!.body.messages as { role: string; content: string }[])
      .find((m) => m.role === 'user'))!.content
    expect(user).toMatch(/ALREADY SENT TO THIS PERSON/)
    expect(user).toContain('worth connecting')
  })

  it('passes recent messages to others so it does not echo them', async () => {
    stubOpenAI({ text: 'ok' })
    await rewriteDraft({ ...BASE, recentToOthers: ['Hi Borong — most of my work is...'] })
    const messages = sent!.body.messages as { role: string; content: string }[]
    expect(messages.find((m) => m.role === 'user')!.content).toMatch(/RECENT MESSAGES/)
    expect(messages.find((m) => m.role === 'system')!.content).toMatch(/Do not reuse their openings/)
  })

  it('refuses a rewrite that came back over the limit instead of truncating it', async () => {
    // Cutting a note mid-sentence to fit is worse than saying the input is too long.
    stubOpenAI({ text: 'x'.repeat(400) })
    const r = await rewriteDraft(BASE)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/over the 300 limit/)
    expect(!r.ok && r.retryable).toBe(true)
  })

  it('asks for a subject only when it is an email', async () => {
    stubOpenAI({ text: 'body', subject: 'court reporting turnaround' })
    const r = await rewriteDraft({ ...BASE, kind: 'email', limit: 2000 })
    expect(r.ok && r.subject).toBe('court reporting turnaround')

    stubOpenAI({ text: 'body' })
    const li = await rewriteDraft(BASE)
    const system = ((sent!.body.messages as { role: string; content: string }[])
      .find((m) => m.role === 'system'))!.content
    expect(system).not.toMatch(/"subject"/)
    expect(li.ok && li.subject).toBeUndefined()
  })

  it('does not retry a bad key or an empty account', async () => {
    stubOpenAI('{"error":{"message":"Incorrect API key"}}', 401)
    const bad = await rewriteDraft(BASE)
    expect(!bad.ok && bad.retryable).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/Check OPENAI_API_KEY/)

    stubOpenAI('{"error":{"code":"insufficient_quota"}}', 429)
    const broke = await rewriteDraft(BASE)
    expect(!broke.ok && broke.retryable).toBe(false)
    expect(!broke.ok && broke.error).toMatch(/no credit/)
  })

  it('retries ordinary rate limiting', async () => {
    stubOpenAI('{"error":{"message":"Rate limit reached"}}', 429)
    const r = await rewriteDraft(BASE)
    expect(!r.ok && r.retryable).toBe(true)
  })

  it('asks for something before rewriting nothing', async () => {
    const r = await rewriteDraft({ ...BASE, rough: '   ' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryable).toBe(false)
  })

  it('is absent rather than broken without a key', async () => {
    fakeEnv.OPENAI_API_KEY = undefined
    const r = await rewriteDraft(BASE)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryable).toBe(false)
  })
})

describe('catching an invented number', () => {
  it('flags a figure that is in neither the notes nor the record', async () => {
    // The shape an invented detail takes: a confident number nobody recorded.
    const claims = unsupportedClaims(
      'Hi Andrew — I saw DepoStack grew 40% last year and wanted to connect.',
      BASE
    )
    expect(claims.some((c) => c.includes('40'))).toBe(true)
  })

  it('leaves alone a number the operator or the record supplied', () => {
    const req = {
      ...BASE,
      rough: 'we cut their turnaround from 10 days to 3',
      facts: { ...BASE.facts, employeeCount: 17 },
    }
    expect(unsupportedClaims('We cut turnaround from 10 days to 3.', req)).toEqual([])
    expect(unsupportedClaims('A team of 17 feels this most.', req)).toEqual([])
  })
})
