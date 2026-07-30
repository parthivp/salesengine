import { promises as dns } from 'node:dns'

/**
 * Deliverability guardrails.
 *
 * Cold outreach fails from bad deliverability far more often than from bad
 * copy or missing features. These checks are cheap, run before a mailbox is
 * allowed to send, and block rather than warn — a warning gets dismissed.
 */

// ---------------------------------------------------------------------------
// DNS authentication
// ---------------------------------------------------------------------------

export type AuthCheck = {
  spf: { ok: boolean; record?: string; reason?: string }
  dkim: { ok: boolean; selector?: string; reason?: string }
  dmarc: { ok: boolean; record?: string; policy?: string; reason?: string }
}

async function txt(name: string): Promise<string[]> {
  try {
    const records = await dns.resolveTxt(name)
    return records.map((chunks) => chunks.join(''))
  } catch {
    return []
  }
}

export async function checkSpf(domain: string) {
  const records = (await txt(domain)).filter((r) => r.toLowerCase().startsWith('v=spf1'))
  if (!records.length) return { ok: false, reason: 'No SPF record found on the domain.' }
  if (records.length > 1) {
    return {
      ok: false,
      record: records.join(' | '),
      // More than one SPF record is a hard failure per RFC 7208, not a warning.
      reason: 'Multiple SPF records found. RFC 7208 permits exactly one; receivers will fail SPF.',
    }
  }
  const record = records[0]
  if (/\+all/i.test(record)) {
    return { ok: false, record, reason: 'SPF ends in +all, which authorises any sender.' }
  }
  return { ok: true, record }
}

/** SES publishes three CNAME-based DKIM selectors; a custom selector may be supplied. */
export async function checkDkim(domain: string, selectors: string[] = ['default', 'selector1', 'google']) {
  for (const selector of selectors) {
    const records = await txt(`${selector}._domainkey.${domain}`)
    if (records.some((r) => r.toLowerCase().includes('v=dkim1') || r.toLowerCase().includes('p='))) {
      return { ok: true, selector }
    }
    try {
      await dns.resolveCname(`${selector}._domainkey.${domain}`)
      return { ok: true, selector }
    } catch {
      // try the next selector
    }
  }
  return {
    ok: false,
    reason: `No DKIM record found for selectors: ${selectors.join(', ')}.`,
  }
}

export async function checkDmarc(domain: string) {
  const records = (await txt(`_dmarc.${domain}`)).filter((r) => r.toLowerCase().startsWith('v=dmarc1'))
  if (!records.length) return { ok: false, reason: 'No DMARC record found.' }
  const record = records[0]
  const policy = /p\s*=\s*(none|quarantine|reject)/i.exec(record)?.[1]?.toLowerCase()
  if (!policy) return { ok: false, record, reason: 'DMARC record has no policy (p=) tag.' }
  // p=none still authenticates; it just does not instruct receivers to act. We
  // accept it so teams are not blocked, but the UI shows it as the weakest tier.
  return { ok: true, record, policy }
}

export async function checkDomainAuth(domain: string, dkimSelectors?: string[]): Promise<AuthCheck> {
  const [spf, dkim, dmarc] = await Promise.all([
    checkSpf(domain),
    checkDkim(domain, dkimSelectors),
    checkDmarc(domain),
  ])
  return { spf, dkim, dmarc }
}

/** A mailbox may only send when SPF and DKIM both pass. DMARC is advisory. */
export function maySend(auth: AuthCheck): { allowed: boolean; blockers: string[] } {
  const blockers: string[] = []
  if (!auth.spf.ok) blockers.push(auth.spf.reason ?? 'SPF failed.')
  if (!auth.dkim.ok) blockers.push(auth.dkim.reason ?? 'DKIM failed.')
  return { allowed: blockers.length === 0, blockers }
}

// ---------------------------------------------------------------------------
// Content linting
// ---------------------------------------------------------------------------

const SPAM_PHRASES = [
  'act now', 'apply now', 'buy direct', 'call now', 'cash bonus', 'cheap',
  'click below', 'click here', 'congratulations', 'credit card offers',
  'dear friend', 'double your', 'earn extra cash', 'eliminate debt',
  'expire', 'fast cash', 'for free', 'free access', 'free consultation',
  'free gift', 'free trial', 'get paid', 'guarantee', 'increase sales',
  'increase traffic', 'limited time', 'lose weight', 'lowest price',
  'make money', 'no catch', 'no cost', 'no credit check', 'no fees',
  'no obligation', 'no purchase necessary', 'no strings attached',
  'not spam', 'offer expires', 'once in a lifetime', 'only $', 'order now',
  'presently', 'promise you', 'pure profit', 'risk free', 'satisfaction guaranteed',
  'save big', 'special promotion', 'this is not spam', 'unlimited',
  'urgent', 'winner', 'you have been selected',
]

export type LintFinding = {
  severity: 'error' | 'warning' | 'info'
  message: string
  detail?: string
}

export type LintResult = {
  score: number // 0 (clean) to 100 (very likely filtered)
  findings: LintFinding[]
  blocking: boolean
}

/**
 * Heuristics, honestly labelled as such. This does not predict a spam score —
 * no client-side check can. It catches the patterns that reliably hurt, so a rep
 * gets told before 2,000 sends rather than after.
 */
export function lintContent(input: {
  subject: string
  bodyText: string
  bodyHtml?: string
  hasUnsubscribe?: boolean
}): LintResult {
  const { subject, bodyText, bodyHtml = '', hasUnsubscribe = true } = input
  const findings: LintFinding[] = []
  let score = 0

  const haystack = `${subject} ${bodyText}`.toLowerCase()
  const hits = SPAM_PHRASES.filter((p) => haystack.includes(p))
  if (hits.length) {
    score += Math.min(35, hits.length * 8)
    findings.push({
      severity: hits.length > 2 ? 'error' : 'warning',
      message: `${hits.length} spam-trigger phrase${hits.length === 1 ? '' : 's'} found`,
      detail: hits.slice(0, 6).join(', '),
    })
  }

  if (!subject.trim()) {
    score += 25
    findings.push({ severity: 'error', message: 'Subject is empty' })
  } else {
    if (subject.length > 70) {
      score += 8
      findings.push({
        severity: 'warning',
        message: 'Subject is long',
        detail: `${subject.length} characters — mobile clients truncate around 40.`,
      })
    }
    const letters = subject.replace(/[^a-z]/gi, '')
    const upper = subject.replace(/[^A-Z]/g, '')
    if (letters.length > 6 && upper.length / letters.length > 0.5) {
      score += 15
      findings.push({ severity: 'error', message: 'Subject is mostly capital letters' })
    }
    if ((subject.match(/!/g)?.length ?? 0) > 1) {
      score += 10
      findings.push({ severity: 'warning', message: 'Multiple exclamation marks in the subject' })
    }
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(subject)) {
      score += 5
      findings.push({
        severity: 'info',
        message: 'Emoji in the subject',
        detail: 'Fine for warm audiences; measurably worse for cold B2B.',
      })
    }
  }

  const words = bodyText.trim().split(/\s+/).filter(Boolean).length
  if (words < 20) {
    score += 10
    findings.push({
      severity: 'warning',
      message: 'Body is very short',
      detail: `${words} words. Very short cold emails often read as templated.`,
    })
  }
  if (words > 300) {
    score += 8
    findings.push({
      severity: 'warning',
      message: 'Body is long',
      detail: `${words} words. Cold email reply rates fall sharply past ~150.`,
    })
  }

  const links = [...bodyText.matchAll(/https?:\/\/\S+/g), ...bodyHtml.matchAll(/href="https?:\/\/[^"]+"/g)]
  if (links.length > 3) {
    score += 12
    findings.push({
      severity: 'warning',
      message: `${links.length} links in one email`,
      detail: 'Filters weight link density heavily on a first touch.',
    })
  }

  if (bodyHtml) {
    const textLength = bodyText.replace(/\s/g, '').length
    const htmlLength = bodyHtml.replace(/\s/g, '').length
    if (textLength > 0 && htmlLength / textLength > 6) {
      score += 10
      findings.push({
        severity: 'warning',
        message: 'Heavy HTML relative to text',
        detail: 'Plain-text-style HTML performs better on cold sends.',
      })
    }
    if (/<img/i.test(bodyHtml)) {
      score += 5
      findings.push({
        severity: 'info',
        message: 'Contains an image',
        detail: 'Images are often blocked by default and can trip filters on a first touch.',
      })
    }
  }

  if (!hasUnsubscribe) {
    score += 20
    findings.push({
      severity: 'error',
      message: 'No unsubscribe mechanism',
      detail: 'Required by CAN-SPAM and GDPR, and a major reputation factor.',
    })
  }

  score = Math.min(100, score)
  return {
    score,
    findings,
    blocking: findings.some((f) => f.severity === 'error'),
  }
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export const REPUTATION_LIMITS = {
  /** AWS places an account under review above 5% bounce; act well before that. */
  bounceWarn: 0.03,
  bounceStop: 0.05,
  /** AWS threshold is 0.1%; there is no safe margin above it. */
  complaintWarn: 0.0005,
  complaintStop: 0.001,
}

export type ReputationVerdict = {
  action: 'ok' | 'warn' | 'pause'
  reasons: string[]
}

/**
 * Judged on a minimum volume, because 1 bounce in 3 sends is 33% and means
 * nothing. Below the floor we stay quiet rather than pausing a new mailbox.
 */
export function assessReputation(input: {
  sent: number
  bounced: number
  complained: number
  minVolume?: number
}): ReputationVerdict {
  const { sent, bounced, complained, minVolume = 50 } = input
  if (sent < minVolume) return { action: 'ok', reasons: [] }

  const bounceRate = bounced / sent
  const complaintRate = complained / sent
  const reasons: string[] = []
  let action: ReputationVerdict['action'] = 'ok'

  if (complaintRate >= REPUTATION_LIMITS.complaintStop) {
    action = 'pause'
    reasons.push(`Complaint rate ${(complaintRate * 100).toFixed(3)}% is at or above the 0.1% limit.`)
  } else if (complaintRate >= REPUTATION_LIMITS.complaintWarn) {
    action = 'warn'
    reasons.push(`Complaint rate ${(complaintRate * 100).toFixed(3)}% is approaching the 0.1% limit.`)
  }

  if (bounceRate >= REPUTATION_LIMITS.bounceStop) {
    action = 'pause'
    reasons.push(`Bounce rate ${(bounceRate * 100).toFixed(1)}% is at or above 5%.`)
  } else if (bounceRate >= REPUTATION_LIMITS.bounceWarn) {
    if (action === 'ok') action = 'warn'
    reasons.push(`Bounce rate ${(bounceRate * 100).toFixed(1)}% is elevated.`)
  }

  return { action, reasons }
}
