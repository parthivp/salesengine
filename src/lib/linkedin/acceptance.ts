import { db, tid } from '../db'
import { normalizeLinkedIn } from '../leads/dedupe'

/**
 * "Did they accept my connection request?"
 *
 * The app cannot see LinkedIn — that is the whole premise, and it is not going to
 * change. So the queue used to answer this question with a reminder task four days
 * later, which puts the work back on the rep: open LinkedIn, look, remember. After
 * twenty invitations a day for two weeks, nobody does that reliably, and the value
 * of a connection request is entirely in the message that follows acceptance.
 *
 * The way out is that LinkedIn *emails you* when somebody accepts, and the worker
 * already polls that mailbox for replies. Reading your own inbox is not scraping,
 * breaches nothing, and needs no permission from LinkedIn. The notification is
 * addressed to you, about you.
 *
 * Two sources, in order of usefulness:
 *
 *   1. **The notification email.** Near-real-time, no work from the rep.
 *   2. **The Connections export** (Settings → Data privacy → Get a copy of your
 *      data). LinkedIn's own official export, with a `Connected On` date. Slower
 *      and manual, but it is a complete list, so it backfills anything the mailbox
 *      missed — notifications turned off, mail deleted, invitations sent before
 *      this feature existed.
 *
 * Neither can tell you about a *declined* invitation. LinkedIn does not notify on
 * decline and does not export it. An invitation that never turns into a connection
 * is genuinely indistinguishable from one still pending, and the UI says so rather
 * than inventing a status.
 */

/** Where LinkedIn's own notifications come from. */
const LINKEDIN_SENDER = /@(?:e\.|el\.|em\.|bounce\.)?linkedin\.com$/i

/**
 * Header-first, for the same reason the reply classifier is: the subject line is
 * translated into every language LinkedIn supports, and matching English prose
 * means the feature silently stops working for anyone whose account is not in
 * English. These headers are not.
 */
const ACCEPT_HEADER_VALUES = /\b(invite[_-]?accept|invitation[_-]?accept|accepted[_-]?invit|new[_-]?connection)\w*/i

/**
 * Subject fallback, for the case where the transport dropped the headers. English
 * plus the phrasings that survive translation as proper nouns. Deliberately narrow:
 * a false positive here marks somebody connected who is not, and the rep then sends
 * a message that cannot be delivered.
 */
const ACCEPT_SUBJECT =
  /\b(accepted your (connection )?(invitation|request)|is now a connection|you (are|and .{1,60} are) now connected|new connection)\b/i

/** LinkedIn wraps profile links, so this looks for the slug anywhere in the body. */
const PROFILE_IN_BODY = /linkedin\.com(?:%2F|\/)in(?:%2F|\/)([A-Za-z0-9\-_%À-ÿ]{3,150})/gi

export type AcceptanceSignal = {
  /** Normalised `linkedin.com/in/slug` values found in the notification. */
  profiles: string[]
}

/**
 * Is this message LinkedIn telling us an invitation was accepted?
 *
 * Returns null for anything else, including LinkedIn's many other notification
 * types — a false positive is worse than a miss, because the Connections export
 * will catch a miss and nothing catches a wrong "connected".
 */
export function detectAcceptance(msg: {
  fromEmail: string
  subject: string
  bodyText?: string | null
  bodyHtml?: string | null
  headers?: Record<string, string> | null
}): AcceptanceSignal | null {
  if (!LINKEDIN_SENDER.test(msg.fromEmail.trim())) return null

  const headerHit = Object.entries(msg.headers ?? {}).some(
    ([k, v]) => /^x-linkedin/i.test(k) && ACCEPT_HEADER_VALUES.test(String(v))
  )
  if (!headerHit && !ACCEPT_SUBJECT.test(msg.subject)) return null

  // The profile URL is the key we already dedupe contacts on, so matching by it
  // is exact. Matching by the display name in the subject is not: "Andrew Mayes"
  // may be two contacts, or spelled differently, or absent from a localised subject.
  const haystack = `${msg.subject}\n${msg.bodyText ?? ''}\n${msg.bodyHtml ?? ''}`
  const profiles = new Set<string>()
  for (const m of haystack.matchAll(PROFILE_IN_BODY)) {
    const slug = decodeURIComponent(m[1]).replace(/[^A-Za-z0-9\-_À-ÿ].*$/, '')
    const normalised = normalizeLinkedIn(`linkedin.com/in/${slug}`)
    if (normalised) profiles.add(normalised)
  }

  return { profiles: [...profiles] }
}

export type AcceptanceResult = {
  matched: number
  alreadyKnown: number
  unmatched: string[]
}

/**
 * Records acceptance against contacts, and unblocks the follow-up.
 *
 * Must be called inside a tenant context.
 */
export async function recordAcceptance(
  profiles: string[],
  at: Date
): Promise<AcceptanceResult> {
  const result: AcceptanceResult = { matched: 0, alreadyKnown: 0, unmatched: [] }

  for (const profile of profiles) {
    const contact = await db().contact.findFirst({
      where: { linkedinUrl: { contains: profile, mode: 'insensitive' } },
      select: { id: true, firstName: true, linkedinConnectedAt: true },
    })
    if (!contact) {
      // Someone accepted who is not in the CRM — a connection request sent outside
      // the queue, or an inbound invitation. Not an error, and worth surfacing
      // rather than swallowing.
      result.unmatched.push(profile)
      continue
    }
    if (contact.linkedinConnectedAt) {
      result.alreadyKnown++
      continue
    }

    await db().contact.update({
      where: { id: contact.id },
      data: {
        linkedinConnectedAt: at,
        // A connection is engagement. It is not a reply, so it does not touch a
        // sequence — but it should stop this person looking like an untouched lead.
        status: 'engaged',
      },
    })

    await db().activity.create({
      data: {
        tenantId: tid(),
        type: 'linkedin',
        summary: 'Accepted the connection request',
        contactId: contact.id,
        detail: { source: 'linkedin-notification-email', profile },
      },
    })

    // The follow-up task was scheduled four days out on the assumption nobody
    // would know when acceptance happened. Now we do: bring it forward, because
    // the window where a message is welcome is right after acceptance.
    await db().task.updateMany({
      where: { contactId: contact.id, type: 'linkedin', status: 'open' },
      data: {
        dueAt: at,
        priority: 2,
        title: `Message ${contact.firstName ?? 'them'} — they accepted`,
      },
    })

    result.matched++
  }

  return result
}
