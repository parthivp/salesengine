import { env } from '../env'
import { logger } from '../logger'

/**
 * Turns a rough draft into a sendable one.
 *
 * The point is not that the model writes better outreach than a person — it does
 * not. The point is that saying the right thing and saying it in fluent English
 * are separate skills, and an operator who has the first should not be blocked by
 * the second. What they know about a prospect, and what they want to say, is the
 * part a model cannot supply. Word order is the part it can.
 *
 * **The model is given facts and asked to phrase them.** It never sees a blank
 * page. Everything it may refer to is passed in explicitly from the record, and
 * the instruction says to use nothing else — because the failure that matters here
 * is not clumsy prose, it is a confident sentence about a company detail nobody
 * ever recorded. On LinkedIn one invented fact costs the relationship outright,
 * which is exactly why `draftMessage` was built rule-based in the first place.
 *
 * So this sits *beside* that engine rather than replacing it. The rules produce a
 * grounded starting point; this rewrites the operator's own words. Neither invents.
 *
 * Output is checked rather than trusted: length, merge tags, and the caller's own
 * `checkDraft`. A model that ignores an instruction is not an anomaly to be
 * surprised by, it is Tuesday.
 */

const OPENAI = 'https://api.openai.com/v1/chat/completions'

/** Long enough for a real note, short enough that a runaway response cannot cost much. */
const MAX_OUTPUT_TOKENS = 400

/**
 * How many previous messages to show the model.
 *
 * Enough to avoid repeating yourself, few enough that the prompt stays cheap and
 * the model does not start averaging them into house style.
 */
const HISTORY_LIMIT = 6

export function rewriteEnabled(): boolean {
  return Boolean(env.OPENAI_API_KEY)
}

export type RewriteRequest = {
  /** The operator's own words. May be rough, ungrammatical, or in note form. */
  rough: string
  /** 'connect' and 'message' are LinkedIn; 'email' has a subject and more room. */
  kind: 'connect' | 'message' | 'email'
  /** Hard character ceiling. LinkedIn enforces 300 on a connection note. */
  limit: number
  /**
   * Facts from the record, already resolved. Only these may be referred to —
   * the model is not given the contact row and cannot go looking for more.
   */
  facts: {
    firstName?: string | null
    title?: string | null
    company?: string | null
    industry?: string | null
    employeeCount?: number | null
    city?: string | null
    emailedAlready?: boolean
    repliedAlready?: boolean
    connectedOnLinkedIn?: boolean
  }
  /** Previous messages to *this* person, oldest first. Context, not a template. */
  priorToContact?: string[]
  /** Recent messages to *other* people. Present so the model can avoid echoing them. */
  recentToOthers?: string[]
  /** How the operator writes: their own sent messages, if any exist. */
  senderName?: string | null
}

export type RewriteResult =
  | { ok: true; text: string; subject?: string }
  | { ok: false; error: string; retryable: boolean }

/** Only the facts that are actually present, as a plain list the model can read. */
function factLines(f: RewriteRequest['facts']): string {
  const lines: string[] = []
  if (f.firstName) lines.push(`First name: ${f.firstName}`)
  if (f.title) lines.push(`Their job title: ${f.title}`)
  if (f.company) lines.push(`Their company: ${f.company}`)
  if (f.industry) lines.push(`Their industry: ${f.industry}`)
  if (f.employeeCount != null) lines.push(`Company headcount: ${f.employeeCount}`)
  if (f.city) lines.push(`Their location: ${f.city}`)
  if (f.emailedAlready) lines.push('You have already emailed this person.')
  if (f.repliedAlready) lines.push('This person has already replied to you.')
  if (f.connectedOnLinkedIn) lines.push('You are already connected on LinkedIn.')
  return lines.length ? lines.join('\n') : '(nothing on record beyond their name)'
}

function systemPrompt(req: RewriteRequest): string {
  const medium =
    req.kind === 'email'
      ? 'a short cold email'
      : req.kind === 'connect'
        ? 'a LinkedIn connection request note'
        : 'a LinkedIn direct message'

  return [
    `You rewrite ${medium} for a salesperson whose first language is not English.`,
    '',
    'Your job is to make their meaning clear and natural. It is not to make it',
    'longer, more enthusiastic, or more salesy.',
    '',
    'Rules, in order of importance:',
    `1. Use ONLY the facts listed under FACTS. Never state anything else about the`,
    '   recipient or their company — not an inference, not a guess, not a detail that',
    '   "would probably be true". If the salesperson\'s notes mention something not in',
    '   FACTS, keep it only if it is about the SENDER, and drop it if it is a claim',
    '   about the recipient.',
    '2. Keep the salesperson\'s intent and their ask. Do not invent a different offer.',
    `3. Stay under ${req.limit} characters, including the sign-off. Shorter is better.`,
    '4. Plain language. No "I hope this finds you well", no "reaching out", no',
    '   "synergy", "circle back", "touch base", "leverage", "game-changer". No emoji.',
    '   No exclamation marks.',
    '5. Sound like one person writing to another. British or neutral English.',
    req.recentToOthers?.length
      ? '6. RECENT MESSAGES shows what this salesperson recently sent other people.\n   Do not reuse their openings or sentence shapes — this person may compare notes\n   with a colleague, and two identical "personal" notes is worse than one obvious\n   template.'
      : '',
    '',
    req.kind === 'email'
      ? 'Reply as JSON: {"subject": "...", "text": "..."}. The subject is under 60 characters, lowercase-ish, and says something specific — not "Quick question".'
      : 'Reply as JSON: {"text": "..."}.',
  ]
    .filter(Boolean)
    .join('\n')
}

function userPrompt(req: RewriteRequest): string {
  const parts = [`FACTS (the only things you may say about them):\n${factLines(req.facts)}`]

  if (req.senderName) parts.push(`SENDER'S NAME: ${req.senderName}`)

  if (req.priorToContact?.length) {
    parts.push(
      `ALREADY SENT TO THIS PERSON (oldest first) — do not repeat these:\n` +
        req.priorToContact.slice(-HISTORY_LIMIT).map((m, i) => `${i + 1}. ${m}`).join('\n')
    )
  }

  if (req.recentToOthers?.length) {
    parts.push(
      `RECENT MESSAGES to other people — avoid these shapes:\n` +
        req.recentToOthers.slice(0, HISTORY_LIMIT).map((m, i) => `${i + 1}. ${m}`).join('\n')
    )
  }

  parts.push(`WHAT THE SALESPERSON WANTS TO SAY:\n${req.rough.trim()}`)
  return parts.join('\n\n')
}

/**
 * Sends a fact a model invented back where it came from.
 *
 * Not a full hallucination detector — there is no such thing — but it catches the
 * specific failure this feature invites: a number or a proper noun appearing in
 * the output that is in neither the operator's notes nor the record. That is the
 * shape an invented detail takes.
 */
export function unsupportedClaims(text: string, req: RewriteRequest): string[] {
  const allowed = [
    req.rough,
    req.senderName ?? '',
    ...Object.values(req.facts).map((v) => (v == null ? '' : String(v))),
  ]
    .join(' ')
    .toLowerCase()

  const found: string[] = []

  // Numbers are the clearest case: a headcount, a percentage, a funding round.
  for (const m of text.matchAll(/\b\d[\d,.]*\s*(%|percent|million|billion|k\b|m\b)?/gi)) {
    const raw = m[0].trim()
    const digits = raw.replace(/[^\d]/g, '')
    if (digits && !allowed.includes(digits)) found.push(raw)
  }

  return [...new Set(found)]
}

export async function rewriteDraft(req: RewriteRequest): Promise<RewriteResult> {
  if (!env.OPENAI_API_KEY) {
    return { ok: false, error: 'No OpenAI key configured.', retryable: false }
  }
  if (!req.rough.trim()) {
    return { ok: false, error: 'Write a rough version first — even a few words.', retryable: false }
  }

  let res: Response
  try {
    res = await fetch(OPENAI, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        // Low but not zero: at zero the same rough note always produces the same
        // sentence, which defeats the point of not sending everyone the same thing.
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(req) },
          { role: 'user', content: userPrompt(req) },
        ],
      }),
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not reach OpenAI.',
      retryable: true,
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 401 is a bad key and 429 with "insufficient_quota" is an empty account —
    // neither improves on retry, and both need the operator, not the scheduler.
    const outOfCredit = /insufficient_quota|billing/i.test(body)
    return {
      ok: false,
      error:
        res.status === 401
          ? 'OpenAI rejected the key. Check OPENAI_API_KEY.'
          : outOfCredit
            ? 'The OpenAI account has no credit. Add billing at platform.openai.com.'
            : `OpenAI returned ${res.status}: ${body.slice(0, 200)}`,
      retryable: res.status === 429 && !outOfCredit,
    }
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const raw = json.choices?.[0]?.message?.content
  if (!raw) return { ok: false, error: 'OpenAI returned an empty response.', retryable: true }

  let parsed: { text?: string; subject?: string }
  try {
    parsed = JSON.parse(raw)
  } catch {
    // response_format should prevent this, but a model that ignores an
    // instruction is not an anomaly.
    return { ok: false, error: 'Could not read the rewritten draft.', retryable: true }
  }

  const text = (parsed.text ?? '').trim()
  if (!text) return { ok: false, error: 'OpenAI returned an empty draft.', retryable: true }

  if (text.length > req.limit) {
    // Refuse rather than truncate. Cutting a note mid-sentence to fit is worse
    // than telling the operator their input needs to be shorter.
    logger.info({ length: text.length, limit: req.limit }, 'rewrite came back over the limit')
    return {
      ok: false,
      error: `The rewrite came back at ${text.length} characters, over the ${req.limit} limit. Try saying less in the rough version.`,
      retryable: true,
    }
  }

  return {
    ok: true,
    text,
    subject: parsed.subject?.trim() || undefined,
  }
}
