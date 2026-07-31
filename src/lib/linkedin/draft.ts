import { LIMITS, type LinkedInActionType, limitFor } from './policy'

/**
 * Message drafting.
 *
 * An honest note on "AI": there is no LLM call here. This composes from real
 * signals on the record — seniority, function, company size, industry, whether
 * they have already been emailed — using a small set of openers and hooks.
 *
 * That is a deliberate choice rather than a stub. A 300-character connection note
 * has almost no room for generated prose, and the thing that makes it land is
 * whether the *observation* is true, not whether the sentence is novel. A rule
 * engine that only says things the data supports beats a model that invents a
 * plausible detail about someone's business — on LinkedIn, one hallucinated fact
 * costs the relationship outright.
 *
 * `draftMessage` is the seam: swap its body for a model call and everything
 * around it — the queue, the caps, the length enforcement — is unchanged. What
 * should NOT change is `groundedHooks`: whatever generates the text, it should
 * only be handed facts that are actually on the record.
 */

export type DraftContext = {
  firstName?: string | null
  lastName?: string | null
  title?: string | null
  company?: string | null
  industry?: string | null
  employeeCount?: number | null
  city?: string | null
  country?: string | null
  /** Have we already emailed them? Changes the opener entirely. */
  emailedAlready?: boolean
  repliedAlready?: boolean
  senderFirstName?: string | null
  senderCompany?: string | null
  /**
   * Stable per-contact value (the contact id) used to choose a phrasing variant.
   * Deterministic on purpose: the rep must not watch the wording change under them
   * on reload, and two reps looking at the same card must see the same text.
   */
  seed?: string | null
  /** False when the record has no profile URL, so the card cannot be acted on. */
  hasProfileUrl?: boolean
}

/**
 * A grounded fact, in the three grammatical shapes the frames need.
 *
 * One phrasing is not enough. "where the handoffs between systems break" is right
 * after "I emailed you about ___" and wrong after "I work with teams on ___", and
 * an earlier version used the single string in both slots — which is how the queue
 * ended up full of notes reading "I work with teams on how the team is handling
 * pipeline coverage".
 */
export type Hook = {
  key: string
  /** Fits "I emailed you about ___". */
  text: string
  /** Noun phrase; fits "I work with teams on ___". */
  topic?: string
  /** Adverbial; fits "I work with teams ___". */
  clause?: string
  strength: number
}


/**
 * Order is load-bearing: the first match wins, so the *specific* patterns come
 * first. "VP Revenue Operations" contains the word "revenue", so a sales-first
 * list hands a RevOps leader a pipeline-coverage opener — technically a match, and
 * exactly the kind of near-miss that tells the recipient this was automated.
 */
const FUNCTION_HOOKS: { pattern: RegExp; topic: string; question: string }[] = [
  {
    pattern: /\b(revenue operations|rev ?ops|sales ops|sales operations|gtm ops)/i,
    topic: 'the handoffs between systems',
    question: 'where the handoffs between the systems break',
  },
  {
    pattern: /\b(customer success|account management|renewals|csm)\b/i,
    topic: 'renewals and expansion',
    question: 'where accounts get stuck after onboarding',
  },
  {
    pattern: /\b(sales|revenue|account executive|ae|cro|business development|bdr|sdr)\b/i,
    topic: 'pipeline coverage',
    question: 'how the team is covering pipeline',
  },
  {
    pattern: /\b(growth|demand gen|demand|marketing|cmo)\b/i,
    topic: 'what converts from outbound',
    question: 'what is actually converting from outbound',
  },
  {
    pattern: /\b(operations|operating officer|coo|supply|logistics|fulfil|procurement)/i,
    topic: 'scheduling across sites',
    question: 'how scheduling gets coordinated across sites',
  },
  {
    pattern: /\b(engineering|product|cto|technical|platform)\b/i,
    topic: 'the glue code between systems',
    question: 'how much of the stack is glue code',
  },
  {
    pattern: /\b(finance|cfo|controller|fp&a)\b/i,
    topic: 'forecast accuracy',
    question: 'where forecast accuracy actually comes from',
  },
  {
    pattern: /\b(people|talent|hr|recruit|chro)/i,
    topic: 'onboarding load',
    question: 'onboarding load as the team scales',
  },
]

/**
 * Only facts the record actually supports. Nothing inferred, nothing invented.
 * Ordered by how specific — and therefore how credible — the observation is.
 */
export function groundedHooks(ctx: DraftContext): Hook[] {
  const hooks: Hook[] = []

  if (ctx.repliedAlready) {
    hooks.push({ key: 'replied', text: 'you replied to my note', strength: 10 })
  } else if (ctx.emailedAlready) {
    hooks.push({ key: 'emailed', text: 'I sent you a note by email', strength: 8 })
  }

  const fn = FUNCTION_HOOKS.find((f) => f.pattern.test(ctx.title ?? ''))
  if (fn) hooks.push({ key: 'function', text: fn.question, topic: fn.topic, strength: 6 })

  if (ctx.employeeCount != null) {
    if (ctx.employeeCount >= 1000) {
      hooks.push({
        key: 'size', strength: 4,
        text: 'coordination at your scale', clause: 'at your kind of scale',
      })
    } else if (ctx.employeeCount >= 50) {
      hooks.push({
        key: 'size', strength: 4,
        text: 'the stage where process starts to matter', clause: 'at about your size',
      })
    } else {
      hooks.push({
        key: 'size', strength: 4,
        text: 'doing this without a big ops team', clause: 'without a big ops team',
      })
    }
  }

  if (ctx.industry) {
    hooks.push({
      key: 'industry', strength: 3,
      text: `what other ${ctx.industry.toLowerCase()} teams are doing`,
      clause: `in ${ctx.industry.toLowerCase()}`,
    })
  }

  if (ctx.city) {
    const place = placeWithArticle(ctx.city)
    hooks.push({ key: 'city', strength: 1, text: `teams in ${place}`, clause: `in ${place}` })
  }

  return hooks.sort((a, b) => b.strength - a.strength)
}

/**
 * "in the San Francisco Bay Area", not "in San Francisco Bay Area".
 *
 * LinkedIn's geography field mixes plain city names with region names, and the two
 * take different articles. Bare cities are fine ("in Bengaluru"); region nouns are
 * not ("in Greater London Area" reads as though written by a machine, which is
 * precisely the impression a connection note cannot afford).
 *
 * Matched on the trailing noun rather than a list of place names, because the list
 * of regions is unbounded and the set of nouns LinkedIn uses to build them is not.
 * A location that already starts with "the" is left alone.
 */
const REGION_NOUN = /\b(area|region|metroplex|metro|valley|coast|midlands|riviera|peninsula)$/i

export function placeWithArticle(city: string): string {
  const trimmed = city.trim()
  if (/^the\b/i.test(trimmed)) return trimmed
  return REGION_NOUN.test(trimmed) ? `the ${trimmed}` : trimmed
}

export type Draft = {
  text: string
  action: LinkedInActionType
  /** Which grounded facts the draft leaned on — shown to the rep for review. */
  usedHooks: string[]
  withinLimit: boolean
  limit: number
  /** True when nothing specific was known, so the draft is generic. */
  generic: boolean
  /** Which phrasing variant was chosen, for the duplicate check to reason about. */
  variant: number
}

/**
 * Chooses one of several phrasings from a stable seed.
 *
 * Two people with the same title at the same size of company have identical
 * grounded facts, so a single frame gives them a byte-identical note. Twenty
 * identical notes in a day is the pattern both the recipients and LinkedIn's own
 * abuse tooling notice — and it is the one thing about the draft that can be fixed
 * without inventing a fact. Every frame says the same true thing; only the sentence
 * differs.
 */
function variantIndex(seed: string | null | undefined, count: number): number {
  if (!seed || count <= 1) return 0
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % count
}

export function draftMessage(
  ctx: DraftContext,
  action: LinkedInActionType = 'connect'
): Draft {
  const name = (ctx.firstName ?? '').trim()
  const greeting = name ? `Hi ${name}` : 'Hi'
  const sender = (ctx.senderFirstName ?? '').trim()
  const hooks = groundedHooks(ctx)
  const limit = limitFor(action)

  const used: string[] = []
  const top = hooks[0]

  let frames: string[]

  if (top?.key === 'replied') {
    used.push('replied')
    frames = [
      `${greeting} — thanks for coming back to me. Sending a connection request so it is easier to keep the thread going here.`,
      `${greeting} — good to hear from you. Connecting here so the thread is easier to pick up.`,
      `${greeting} — thanks for the reply. Adding you here so we are not relying on email.`,
    ]
  } else if (top?.key === 'emailed') {
    used.push('emailed')
    // The "about ___" slot needs a subject, and company size is not one — "I
    // emailed you about the stage where process starts to matter" is not a
    // sentence anyone writes. Function and industry are; otherwise name the company.
    const second = hooks.find((h) => h.key === 'function' || h.key === 'industry')
    if (second) used.push(second.key)
    const about = second ? second.text : (ctx.company ?? 'your team')
    frames = [
      `${greeting} — I emailed you earlier about ${about}. Worth connecting either way.`,
      `${greeting} — I sent you a note about ${about}. Connecting here too, so it is easy to reply.`,
      `${greeting} — I wrote to you about ${about} and did not want to chase it by email. Connecting either way.`,
    ]
  } else if (top?.key === 'function' && top.topic) {
    used.push('function')
    const size = hooks.find((h) => h.key === 'size')
    if (size) used.push('size')
    const who = ctx.industry ? `${ctx.industry.toLowerCase()} teams` : 'teams'
    const qualifier = size?.clause ? `, usually ${size.clause}` : ''
    frames = [
      `${greeting} — I work with ${who} on ${top.topic}${qualifier}. Keen to compare notes rather than pitch you.`,
      // Never front the topic as the subject. "Handoffs between systems is most of
      // what I do" is an agreement error, and the topics are a mix of singular and
      // plural nouns — so the fix is a frame where the subject is always "my work",
      // not a plural-detection heuristic.
      // The size qualifier goes at the *end* of the clause in both of these, never
      // after `who`. Mid-clause it lands between the subject and its verb with no
      // closing comma — "a lot of my work with teams, usually at about your size is
      // pipeline coverage."
      `${greeting} — most of my work with ${who} comes down to ${top.topic}${qualifier}. Would be good to compare notes.`,
      `${greeting} — a lot of my work with ${who} is ${top.topic}${qualifier}. Reaching out to compare notes, not to pitch.`,
    ]
  } else if (top?.key === 'size' && top.clause) {
    used.push('size')
    // Both frames keep the clause post-nominal ("teams ___"). As a predicate it
    // breaks for the small-company wording: "the teams I work with are without a
    // big ops team" is not a sentence.
    frames = [
      `${greeting} — most of my work is with teams ${top.clause}. Thought it was worth connecting.`,
      `${greeting} — I spend my time with teams ${top.clause}, so we are likely to overlap. Worth connecting.`,
    ]
  } else if ((top?.key === 'industry' || top?.key === 'city') && top.clause) {
    used.push(top.key)
    frames = [
      `${greeting} — a lot of the teams I work with are ${top.clause}. Thought it was worth connecting.`,
      `${greeting} — I work with a fair few teams ${top.clause}, so we probably have people in common. Worth connecting.`,
    ]
  } else {
    frames = [
      `${greeting} — we work with teams like ${ctx.company ?? 'yours'} and I thought it was worth connecting.`,
      `${greeting} — I thought it was worth connecting; ${ctx.company ?? 'your team'} is the kind of team we work with.`,
    ]
  }

  const variant = variantIndex(ctx.seed, frames.length)
  let body = frames[variant]

  if (sender) body += `\n\n${sender}`

  const text = tighten(body, limit)

  return {
    text,
    action,
    usedHooks: used,
    withinLimit: text.length <= limit,
    limit,
    // A draft is generic when nothing was known, and *also* when the only thing
    // known was the city. "A lot of the teams I work with are in Los Angeles" is
    // grammatical, personalised-looking, and says nothing — two people in the same
    // metro get near-identical notes. Reporting that as personalised is the one
    // failure mode this whole module exists to avoid, so city-only counts as thin.
    generic: used.every((k) => (hooks.find((h) => h.key === k)?.strength ?? 0) <= 1),
    variant,
  }
}

/**
 * Trims to the limit on a sentence boundary rather than mid-word.
 *
 * LinkedIn silently truncates an over-length connection note, which produces a
 * message that ends mid-sentence — worse than a shorter one.
 */
export function tighten(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed

  const cut = trimmed.slice(0, limit)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  if (lastStop > limit * 0.5) return cut.slice(0, lastStop + 1).trim()

  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * A quality gate on the draft, mirroring the email linter. It refuses the things
 * that make a connection note obviously templated.
 */
export type DraftCheck = { severity: 'error' | 'warning' | 'info'; message: string }

export function checkDraft(draft: Draft, ctx: DraftContext): DraftCheck[] {
  const out: DraftCheck[] = []

  if (!draft.withinLimit) {
    out.push({
      severity: 'error',
      message: `Over LinkedIn's ${draft.limit}-character limit — it would be truncated mid-sentence.`,
    })
  }

  if (/\{\{/.test(draft.text)) {
    out.push({ severity: 'error', message: 'Contains an unresolved merge tag.' })
  }

  // An error, not a warning: without the URL there is no profile to open, so
  // there is no action the rep can take from this card and "I sent it" could only
  // ever be wrong.
  if (ctx.hasProfileUrl === false) {
    out.push({
      severity: 'error',
      message: 'No LinkedIn profile URL on this record — add one on the contact before sending.',
    })
  }

  if (!ctx.firstName) {
    out.push({
      severity: 'warning',
      message: 'No first name on the record, so the note opens with a bare “Hi”.',
    })
  }

  if (draft.generic) {
    out.push({
      severity: 'warning',
      message:
        draft.usedHooks.length === 0
          ? 'Nothing specific is known about this person, so the draft is generic. Enriching the ' +
            'record first will land better than sending this.'
          : 'Location is the only thing known about this person, so the draft is close to ' +
            'generic — anyone else in the same place gets nearly the same note. Add industry, ' +
            'headcount or a role signal to the account and rebuild.',
    })
  }

  if (/\b(synergy|circle back|touch base|leverage|solutions provider|game[- ]chang)/i.test(draft.text)) {
    out.push({ severity: 'warning', message: 'Contains filler that reads as templated.' })
  }

  if (draft.action === 'connect' && draft.text.length > 250) {
    out.push({
      severity: 'info',
      message: 'Long for a connection note — short ones are accepted more often.',
    })
  }

  return out
}

export const CONNECTION_NOTE_LIMIT = LIMITS.connectionNote
