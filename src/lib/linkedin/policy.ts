/**
 * What this product will and will not do on LinkedIn.
 *
 * This file exists so the position is in the codebase rather than only in a
 * README, and so the limits are enforced by code rather than remembered.
 *
 * LinkedIn's User Agreement prohibits unauthorised scraping and automated
 * activity. Tools that drive a headless browser or a cloud IP against LinkedIn
 * on a customer's behalf work until detection catches up; the cost of being
 * caught is the sales team's real professional identity going offline.
 *
 * So:
 *
 *   NOT IMPLEMENTED, deliberately
 *     - no headless browser or server-side session against linkedin.com
 *     - no fingerprint rotation, residential proxies, or IP cycling
 *     - no humanised timing jitter designed to defeat classification
 *     - no scraping of profiles, search results, or connection graphs
 *     - no auto-send of connection requests or messages
 *
 *   IMPLEMENTED
 *     - import of Sales Navigator CSV exports (an export LinkedIn itself provides)
 *     - target list building and prioritisation from our own data
 *     - message drafting
 *     - a queue the rep works through, clicking Send themselves in their own
 *       browser, in their own logged-in session
 *
 * The daily caps below are *ergonomic and reputational*, not evasive. They exist
 * because a human sending 200 connection requests in a day is a person whose
 * acceptance rate collapses and whose account gets reported — the limit protects
 * the rep from themselves, and it is surfaced in the UI with that reasoning
 * rather than hidden.
 */

export const LINKEDIN_POLICY = {
  automationImplemented: false,
  evasionImplemented: false,
  sendMechanism: 'human-in-the-loop',
} as const

/**
 * Suggested daily ceilings per action type.
 *
 * Sourced from what LinkedIn publicly signals and what sales teams report as
 * sustainable, not from probing limits. These are advisory ceilings shown to the
 * rep; the queue warns rather than silently truncating, because a hidden cap
 * looks like the product is broken.
 */
export const DAILY_CEILINGS = {
  connect: 20,
  message: 30,
  view: 60,
} as const

export type LinkedInActionType = keyof typeof DAILY_CEILINGS

export type PacingVerdict = {
  allowed: boolean
  remaining: number
  ceiling: number
  message?: string
}

export function assessPacing(
  action: LinkedInActionType,
  doneToday: number
): PacingVerdict {
  const ceiling = DAILY_CEILINGS[action]
  const remaining = Math.max(0, ceiling - doneToday)

  if (remaining === 0) {
    return {
      allowed: false,
      remaining: 0,
      ceiling,
      message:
        `You have sent ${doneToday} ${LABEL[action]} today, which is the suggested ceiling. ` +
        `Past this, acceptance rates fall and accounts get reported — the cards will still be ` +
        `here tomorrow.`,
    }
  }

  if (remaining <= Math.ceil(ceiling * 0.2)) {
    return {
      allowed: true,
      remaining,
      ceiling,
      message: `${remaining} left before the suggested daily ceiling of ${ceiling}.`,
    }
  }

  return { allowed: true, remaining, ceiling }
}

const LABEL: Record<LinkedInActionType, string> = {
  connect: 'connection requests',
  message: 'messages',
  view: 'profile views',
}

export const ACTION_LABEL = LABEL

/**
 * LinkedIn's own limits on what a connection request can carry. Enforced at
 * draft time so a rep never pastes a message that gets silently truncated.
 */
export const LIMITS = {
  /** Connection request note, for members with InMail-less accounts. */
  connectionNote: 300,
  /** Direct message to an existing connection. */
  message: 8000,
} as const

export function withinLimit(action: LinkedInActionType, text: string): boolean {
  const cap = action === 'connect' ? LIMITS.connectionNote : LIMITS.message
  return text.trim().length <= cap
}

export function limitFor(action: LinkedInActionType): number {
  return action === 'connect' ? LIMITS.connectionNote : LIMITS.message
}
