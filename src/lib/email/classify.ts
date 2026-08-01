/**
 * Reply classification.
 *
 * A sequence that keeps sending to someone who already replied is worse than no
 * automation at all, so the engine stops on reply. That makes *what counts as a
 * reply* the load-bearing decision, and it is subtler than it looks:
 *
 *   - An out-of-office is not a reply. Stopping on one loses the prospect for two
 *     weeks because they went to Portugal. This is the single most common bug in
 *     sequencing tools, and it is invisible — the sequence just quietly ends.
 *   - A bounce-back from a mail system is not a reply either.
 *   - "Take me off your list" is a reply *and* an unsubscribe, and treating it as
 *     an ordinary reply leaves them legally on the list.
 *   - "Wrong person, talk to Ana" is a reply that should not mark this contact
 *     interested, but should create a task.
 *
 * On the absence of an LLM: auto-reply detection is done from headers, and that is
 * not a compromise — it is strictly better than reading the prose. RFC 3834 exists
 * precisely so that machines can identify machine-generated mail, and a vacation
 * responder written in Finnish still sets `Auto-Submitted: auto-replied`. Where
 * prose is genuinely needed — is this person interested? — the rules produce a
 * confidence, and anything uncertain is routed to a human rather than guessed at.
 * `classifyReply` is the seam: swap its body for a model call and every consumer
 * is unchanged.
 */

export type ReplyIntent =
  /** A person wrote back and wants to talk. */
  | 'interested'
  /** A person wrote back and does not. */
  | 'not_interested'
  /** Wants off the list. Legally distinct from "not interested". */
  | 'unsubscribe'
  /** Not the right person; usually names someone else. */
  | 'wrong_person'
  /** Machine-generated absence notice. Must NOT stop the sequence. */
  | 'out_of_office'
  /** Some other machine-generated mail (ticket ack, no-reply notice). */
  | 'auto_reply'
  /** A mail system telling us delivery failed. */
  | 'bounce'
  /** A person wrote back, but what they want is unclear. */
  | 'unclear'

export type ReplyClassification = {
  intent: ReplyIntent
  /** 0–1. Below `REVIEW_THRESHOLD` the answer is "ask a human". */
  confidence: number
  /** Whether a human should look before anything irreversible happens. */
  needsReview: boolean
  /** Does this end the sequence? */
  stopsSequence: boolean
  /** Does this require suppressing the address? */
  suppresses: boolean
  /** When the sender said they are back, if they said. */
  returnsAt: Date | null
  /** Human-readable reasons, shown in the inbox so the call is auditable. */
  reasons: string[]
}

export type ReplyInput = {
  subject?: string | null
  bodyText?: string | null
  fromEmail?: string | null
  /** Raw header map, lowercased keys. Headers decide the machine-mail cases. */
  headers?: Record<string, string>
}

/** Below this, a human decides. */
export const REVIEW_THRESHOLD = 0.6

// --- header signals ---------------------------------------------------------

/**
 * RFC 3834 and the de-facto headers every major provider sets. Checked before any
 * prose, because a header is a statement of fact by the sending system while the
 * body is a guess by us.
 */
function machineMailSignals(h: Record<string, string>): string[] {
  const found: string[] = []

  const autoSubmitted = h['auto-submitted']?.toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') found.push(`Auto-Submitted: ${autoSubmitted}`)

  if (h['x-autoreply'] || h['x-autorespond'] || h['x-auto-response-suppress']) {
    found.push('X-Autoreply header')
  }

  const precedence = h['precedence']?.toLowerCase()
  if (precedence === 'auto_reply') found.push(`Precedence: ${precedence}`)

  if (h['x-ms-exchange-inbox-rules-loop']) found.push('Exchange auto-reply loop header')

  // A vacation responder addresses the envelope sender; a real person replies to
  // a mailbox. An empty Return-Path is the classic "do not reply to this" marker.
  const returnPath = h['return-path']?.trim()
  if (returnPath === '<>' || returnPath === '') found.push('Null Return-Path')

  return found
}

/**
 * Headers that say "sent to a list", as distinct from "generated automatically".
 *
 * These used to sit in `machineMailSignals`, where any one of them short-circuited
 * the whole classifier to `auto_reply` at 0.85 confidence — above the review
 * threshold, so not even flagged for a human. That is wrong for a *threaded* reply:
 * some corporate mail systems stamp `Precedence: bulk` on ordinary outbound mail,
 * and a prospect on such a system who wrote "yes, send pricing" was filed as
 * machine mail, did not stop the sequence, and did not get looked at. We kept
 * emailing someone who had replied, which is the failure this whole feature exists
 * to prevent.
 *
 * `Auto-Submitted` and `X-Autoreply` are a system stating it generated the message
 * itself. These are weaker — for unthreaded mail they mean bulk (see
 * `detectBulkMail`, which runs first), and for a real reply they mean very little.
 */
function bulkSignals(h: Record<string, string>): string[] {
  const found: string[] = []
  const precedence = h['precedence']?.toLowerCase()
  if (precedence && ['bulk', 'junk', 'list'].includes(precedence)) {
    found.push(`Precedence: ${precedence}`)
  }
  if (h['feedback-id'] || h['x-campaign-id']) found.push('Bulk-mail header')
  if (h['list-id'] || h['list-unsubscribe']) found.push('Mailing-list header')
  return found
}

function isBounceMessage(h: Record<string, string>, subject: string): boolean {
  const contentType = h['content-type']?.toLowerCase() ?? ''
  if (contentType.includes('report-type=delivery-status')) return true
  if (h['x-failed-recipients']) return true
  // No trailing \b: the last alternative ends in ")", and a word boundary after a
  // non-word character requires a word character next — so at end-of-subject it
  // never matched "Delivery Status Notification (Failure)".
  return /\b(undeliverable|delivery (has )?failed|returned mail|mail delivery (failed|subsystem)|delivery status notification\s*\(failure\))/i.test(
    subject
  )
}

const NOREPLY_LOCALPART = /^(no[-._]?reply|do[-._]?not[-._]?reply|donotreply|postmaster|mailer[-._]?daemon|bounce[sd]?|notifications?|automated)\b/i

// --- prose signals ----------------------------------------------------------

const OOO_SUBJECT =
  /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (my )?(desk|office|email)|on (annual |parental |maternity |paternity )?leave|on holiday|on vacation|abwesenheit|absence du bureau|fuori sede|ausência)\b/i

/**
 * The pronoun-led forms ("I am out of the office") plus the bare ones responders
 * often use as a whole message ("Away from my desk until Monday").
 *
 * The bare forms are deliberately narrow — "away from my desk", not "away" — so
 * that a person writing "sorry, I was away last week, happy to chat" is still read
 * as the live reply it is.
 */
const OOO_BODY =
  /\b(i am|i'm|i will be|currently) (currently )?(out of (the )?office|away|on (leave|holiday|vacation|annual leave)|travell?ing)\b|\bwith limited access to (my )?email\b|\bwill (be )?(back|return(ing)?) (on|in|to the office)\b|\breturning to the office\b|\baway from (my )?(desk|office|email)\b|^\s*(out of (the )?office|automatic reply|auto[- ]?reply)\b/i

const UNSUBSCRIBE =
  /\b(unsubscribe|remove me|take me off|opt[- ]?out|stop (emailing|contacting|sending)|do not (email|contact) me( again)?|delete my (data|details|information)|no longer wish to receive|erase my data)\b/i

/** GDPR / DPA phrasing. Legally an opt-out even when politely worded. */
const DATA_REQUEST =
  /\b(gdpr|data protection|right to erasure|subject access request|where did you get my (email|details|data))\b/i

/**
 * Includes deferrals — "not right now", "circle back next quarter".
 *
 * They belong here rather than being ignored because of what happens when they are
 * not: "not right now, but send me pricing for next quarter" matches only the
 * interest pattern, so it is filed as "Interested — reply today" and a rep calls
 * someone who just said not yet. Scored as a conflict, it reaches a human instead,
 * which is the correct handling of a message that genuinely says both things.
 */
const NOT_INTERESTED =
  /\b(not interested|no thanks|no thank you|we('| a)re (all )?(good|set|sorted)|not (a )?(good )?(fit|priority)( (right|for) now)?|not at th(is|e) (time|moment)|not (right )?now\b|no bandwidth|already have (a|one)|we use \w+ (for this|already)|please stop|pass\b|no need\b|circle back (in|next)|revisit (in|next)|maybe (later|next (quarter|year|month))|try me (again )?(in|next))/i

/**
 * Note the lookbehinds on "interested".
 *
 * As a bare token it matches inside "not interested" — so every polite decline
 * scored as both interested and not interested, tied, and fell through to
 * "unclear". Every rejection in the inbox would have been queued for a human to
 * re-read. The negations have to be excluded at the token, not sorted out later by
 * scoring, because the two patterns are matching the very same characters.
 */
const INTERESTED =
  /(?<!\bnot )(?<!\bnever )(?<!\bnot really )\binterested\b|\b(sounds (good|interesting|great)|happy to (chat|talk|connect|jump on)|let'?s (chat|talk|set|schedule|do it)|book (a|some) time|send (me|over) (some )?(more )?(info|details|pricing|a deck)|tell me more|when (are|would) you (free|available)|what does (it|this) cost|pricing|can you (send|share)|keen\b|yes[,! ]|call me|set up a (call|meeting|demo)|worth a (chat|call|conversation))/i

const WRONG_PERSON =
  /\b(wrong person|not (the )?right person|i (do not|don'?t) (handle|own|look after|manage)|you (should|want|need) (to )?(speak|talk|reach out) to|(reach|reaching) out to \w+ instead|forwarded (this|your email) to|no longer (with|at) (the company|us)|has left the (company|business)|passing (this|you) (on )?to|copying in|best person (for this|to speak to) is)\b/i

const MEETING_BOOKED = /\b(calendar|calendly|invite|scheduled|booked|accepted the (invite|meeting))\b/i

// --- return date ------------------------------------------------------------

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/**
 * The date an out-of-office says they return, so the sequence can resume then
 * rather than on a fixed guess.
 *
 * Deliberately conservative: only the two phrasings that are unambiguous, and a
 * sanity window. A wrong date here silently delays a live prospect by months, so
 * "no date" is a much better answer than a plausible wrong one.
 */
export function parseReturnDate(text: string, now = new Date()): Date | null {
  const t = text.toLowerCase()

  // "back on 14 August" / "returning on August 14" / "until 14/08/2026"
  const dayMonth = new RegExp(
    `\\b(?:back|return(?:ing)?|until|till|from)\\b[^.\\n]{0,24}?\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})\\b`
  ).exec(t)
  const monthDay = new RegExp(
    `\\b(?:back|return(?:ing)?|until|till|from)\\b[^.\\n]{0,24}?\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`
  ).exec(t)

  let month: number | undefined
  let day: number | undefined

  if (dayMonth) {
    day = Number(dayMonth[1])
    month = MONTHS.indexOf(dayMonth[2])
  } else if (monthDay) {
    month = MONTHS.indexOf(monthDay[1])
    day = Number(monthDay[2])
  } else {
    // ISO, which corporate responders often emit: "until 2026-08-14"
    const iso = /\b(?:back|return(?:ing)?|until|till|from)\b[^.\n]{0,24}?\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t)
    if (iso) {
      const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
      return withinWindow(d, now) ? d : null
    }
    return null
  }

  if (month == null || month < 0 || !day || day < 1 || day > 31) return null

  // No year given, which is the normal case. Assume the next occurrence: a
  // responder saying "back on 4 January" in December means next year.
  let year = now.getUTCFullYear()
  let candidate = new Date(Date.UTC(year, month, day))
  if (candidate.getTime() < now.getTime() - 2 * 86_400_000) {
    year += 1
    candidate = new Date(Date.UTC(year, month, day))
  }
  // Reject a rolled-over date (31 February became 3 March).
  if (candidate.getUTCDate() !== day || candidate.getUTCMonth() !== month) return null

  return withinWindow(candidate, now) ? candidate : null
}

/** An out-of-office more than a year out is a parse error, not a long holiday. */
function withinWindow(d: Date, now: Date): boolean {
  const ms = d.getTime() - now.getTime()
  return ms > -3 * 86_400_000 && ms < 366 * 86_400_000
}

// --- the classifier ---------------------------------------------------------

function normaliseHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v
  return out
}

/**
 * Strips quoted history so the classifier reads what *this* person wrote.
 *
 * Without it, every reply contains our own original email, so "interested" matches
 * against our own copy and every single reply looks positive.
 */
export function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/)
  const kept: string[] = []

  for (const line of lines) {
    const t = line.trim()
    if (/^>/.test(t)) break
    if (/^-{2,}\s*(original message|forwarded message)/i.test(t)) break
    if (/^_{5,}$/.test(t)) break
    if (/^on .{4,80}\bwrote:$/i.test(t)) break
    if (/^from:\s.+/i.test(t) && kept.length > 0) break
    if (/^sent from my \w+/i.test(t)) continue
    kept.push(line)
  }

  return kept.join('\n').trim()
}

/**
 * Mail that was sent to a list rather than written to you.
 *
 * A mailbox receives more than replies. LinkedIn job alerts, newsletters, invoices,
 * calendar notifications and every "your weekly summary" all land in the same
 * folder, and the ingest stored each of them as an inbound message — so the Inbox
 * reported "100 replies" when three were replies and ninety-seven were noise, and
 * the one that mattered was on page two of a list that had no page two.
 *
 * This is a *separate* question from what a reply means, which is why it is not
 * another `ReplyIntent`. `auto_reply` describes a machine answering on a person's
 * behalf — an out-of-office, a ticket acknowledgement — and it still concerns your
 * conversation with that person. Bulk mail concerns nothing you did.
 *
 * The signals are all headers rather than prose, because a header is a statement by
 * the sending system and prose is a guess by us. `List-Unsubscribe` in particular
 * is close to definitive: no human composing a reply in a mail client sets it.
 *
 * The caller must still check the message is not threaded to something we sent
 * before acting on this. A prospect who replies from a mail system that stamps
 * bulk headers is a reply, whatever the headers say — see `ingestInbound`.
 */
export function detectBulkMail(input: ReplyInput): { isBulk: boolean; reasons: string[] } {
  const h = normaliseHeaders(input.headers)
  const reasons: string[] = []

  // Set by mailing-list and marketing senders, required by RFC 8058 for bulk mail,
  // and never set by a person writing a reply.
  reasons.push(...bulkSignals(h))
  if (h['list-post'] || h['x-mailer-lid']) reasons.push('Mailing-list header')

  // "jobs-listings@linkedin.com", "notifications@github.com". The local part is the
  // sender telling you not to write back, which is the definition of not a reply.
  const local = (input.fromEmail ?? '').split('@')[0]?.toLowerCase() ?? ''
  if (NOREPLY_LOCALPART.test(local) || /(^|[-._])(jobs?|jobalerts?|invitations?|updates?|digest|newsletter|alerts?|news|marketing|billing|receipts?|invoice)([-._]|$)/.test(local)) {
    reasons.push(`Sent from "${local}"`)
  }

  return { isBulk: reasons.length > 0, reasons }
}

export function classifyReply(input: ReplyInput, now = new Date()): ReplyClassification {
  const headers = normaliseHeaders(input.headers)
  const subject = (input.subject ?? '').trim()
  const rawBody = (input.bodyText ?? '').trim()
  const body = stripQuoted(rawBody)
  const haystack = `${subject}\n${body}`
  const reasons: string[] = []

  const decide = (
    intent: ReplyIntent,
    confidence: number,
    extra: Partial<ReplyClassification> = {}
  ): ReplyClassification => ({
    intent,
    confidence,
    needsReview: confidence < REVIEW_THRESHOLD,
    stopsSequence: false,
    suppresses: false,
    returnsAt: null,
    reasons,
    ...extra,
  })

  // 1. Delivery failure. Not a reply at all.
  if (isBounceMessage(headers, subject)) {
    reasons.push('Delivery status notification')
    return decide('bounce', 0.95, { stopsSequence: true })
  }

  // 2. Opt-out beats everything a human wrote, including an out-of-office that
  //    also says "remove me". Getting this wrong is a legal problem, not a
  //    conversion problem, so it is checked before the machine-mail shortcut.
  if (UNSUBSCRIBE.test(haystack) || DATA_REQUEST.test(haystack)) {
    reasons.push('Explicit opt-out language')
    if (headers['list-unsubscribe']) reasons.push('List-Unsubscribe header present')
    return decide('unsubscribe', 0.9, { stopsSequence: true, suppresses: true })
  }

  // 3. Machine-generated mail, by header first.
  const machine = machineMailSignals(headers)
  const oooProse = OOO_SUBJECT.test(subject) || OOO_BODY.test(body)
  const fromNoreply = NOREPLY_LOCALPART.test((input.fromEmail ?? '').split('@')[0] ?? '')

  if (machine.length > 0 || oooProse || fromNoreply) {
    if (machine.length) reasons.push(...machine)
    if (fromNoreply) reasons.push('From a no-reply address')

    if (oooProse) {
      reasons.push(
        OOO_SUBJECT.test(subject) ? 'Out-of-office subject' : 'Out-of-office phrasing in the body'
      )
      const returnsAt = parseReturnDate(body || subject, now)
      if (returnsAt) reasons.push(`Says they return ${returnsAt.toISOString().slice(0, 10)}`)
      // The whole point: an absence notice must not end the sequence.
      return decide('out_of_office', machine.length ? 0.95 : 0.8, {
        stopsSequence: false,
        returnsAt,
      })
    }

    // Machine mail that is not an absence notice — a ticket acknowledgement, a
    // "your message is awaiting moderation". Also not a reply.
    return decide('auto_reply', machine.length ? 0.85 : 0.65, { stopsSequence: false })
  }

  // 4. A human wrote this. Score the intents and require a clear winner.
  const scores: { intent: ReplyIntent; score: number; why: string }[] = []
  if (WRONG_PERSON.test(body)) scores.push({ intent: 'wrong_person', score: 3, why: 'Points at a different person' })
  if (NOT_INTERESTED.test(body)) scores.push({ intent: 'not_interested', score: 2, why: 'Declines' })
  if (INTERESTED.test(body)) scores.push({ intent: 'interested', score: 2, why: 'Expresses interest' })
  if (MEETING_BOOKED.test(body) && INTERESTED.test(body)) {
    scores.push({ intent: 'interested', score: 1, why: 'Mentions scheduling' })
  }

  if (scores.length === 0) {
    // Nothing a person would write, and the headers said it went to a list. Mail
    // that reached us for some other reason, not a reply — and unlike the branch
    // above, this cannot stop a sequence.
    const bulk = bulkSignals(headers)
    if (bulk.length) {
      reasons.push(...bulk)
      return decide('auto_reply', 0.7, { stopsSequence: false })
    }
    reasons.push('A person replied, but no clear intent — needs a human')
    return decide('unclear', 0.3, { stopsSequence: true })
  }

  // Bulk headers on a message that reads like a person. Recorded so the reasoning
  // is visible, but it does not overrule the prose — it lowers the confidence,
  // which is what puts the message in front of a human.
  const bulk = bulkSignals(headers)
  if (bulk.length) reasons.push(...bulk, 'Bulk headers, but the message reads as written by a person')

  const totals = new Map<ReplyIntent, { score: number; why: string[] }>()
  for (const s of scores) {
    const cur = totals.get(s.intent) ?? { score: 0, why: [] }
    cur.score += s.score
    cur.why.push(s.why)
    totals.set(s.intent, cur)
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1].score - a[1].score)
  const [topIntent, top] = ranked[0]
  const runnerUp = ranked[1]?.[1].score ?? 0

  reasons.push(...top.why)

  // Both "not interested" and "interested" matched — e.g. "not interested right
  // now, but send me pricing for next quarter". Genuinely ambiguous; ask a human
  // rather than picking, because acting on the wrong one is expensive either way.
  if (runnerUp === top.score) {
    reasons.push('Conflicting signals in the same message')
    return decide('unclear', 0.35, { stopsSequence: true })
  }

  const base = top.score >= 3 ? 0.8 : runnerUp === 0 ? 0.7 : 0.55
  // Below REVIEW_THRESHOLD, so a human reads it before anything is assumed.
  const confidence = bulk.length ? Math.min(base, 0.5) : base
  // Every human reply stops the sequence, whatever they said. Continuing to send
  // to a person who is now in a conversation with you is the failure the whole
  // feature exists to prevent.
  return decide(topIntent, confidence, { stopsSequence: true })
}

/** One-line summary for the inbox and the activity timeline. */
export const INTENT_LABEL: Record<ReplyIntent, string> = {
  interested: 'Interested',
  not_interested: 'Not interested',
  unsubscribe: 'Wants off the list',
  wrong_person: 'Wrong person',
  out_of_office: 'Out of office',
  auto_reply: 'Automated reply',
  bounce: 'Delivery failure',
  unclear: 'Needs a look',
}

export const INTENT_TONE: Record<ReplyIntent, 'success' | 'warning' | 'danger' | 'neutral'> = {
  interested: 'success',
  not_interested: 'neutral',
  unsubscribe: 'danger',
  wrong_person: 'warning',
  out_of_office: 'neutral',
  auto_reply: 'neutral',
  bounce: 'danger',
  unclear: 'warning',
}
