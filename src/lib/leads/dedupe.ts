import { db } from '../db'
import { normalizeEmail, domainFromEmail } from '../utils'

/**
 * Deduplication.
 *
 * Two tiers, deliberately:
 *   - deterministic: same email, or same LinkedIn URL. Safe to merge silently.
 *   - fuzzy: same last name + same company domain. Surfaced for review, never
 *     auto-merged — silently collapsing two real people at one company is worse
 *     than leaving a duplicate.
 */

export type DedupeMatch = {
  contactId: string
  confidence: 'exact' | 'high' | 'probable'
  reason: string
}

export type IncomingContact = {
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  linkedinUrl?: string | null
  companyDomain?: string | null
  companyName?: string | null
}

/** Levenshtein-free similarity: adequate for name matching and cheap. */
export function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const shorter = x.length < y.length ? x : y
  const longer = x.length < y.length ? y : x
  if (longer.includes(shorter)) return shorter.length / longer.length
  // bigram overlap
  const grams = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)))
  const gx = grams(x)
  const gy = grams(y)
  let hits = 0
  for (const g of gx) if (gy.has(g)) hits++
  return (2 * hits) / (gx.size + gy.size)
}

/**
 * Reduces a LinkedIn URL to the part that identifies the person.
 *
 * Two shapes count as a profile.
 *
 * The public one — `linkedin.com/in/adalovelace` — is what a CSV or an enrichment
 * provider gives you.
 *
 * The Sales Navigator one — `linkedin.com/sales/lead/ACwAAB...` — is what you get
 * from a saved Sales Navigator page, and it is the *only* identifier those pages
 * carry: they never mention the public URL. Rejecting it would mean nothing parsed
 * out of Sales Navigator could be imported at all, which is the entire point of
 * having a parser. It opens the person in the browser exactly as the public URL
 * does, which is all the queue asks of it.
 *
 * The two are not interchangeable as keys — the same person reached both ways
 * produces two different strings and so two contacts. That is a real limitation
 * with no fix available: LinkedIn does not publish the mapping. The `id,`
 * truncation matters here: Sales Navigator appends a search context after a comma
 * (`ACwAAB...,NAME_SEARCH,u8r5`) that differs between searches for the same person,
 * so keeping it would defeat dedupe entirely.
 */
export function normalizeLinkedIn(url?: string | null): string | null {
  if (!url) return null

  const pub = url.match(/linkedin\.com\/in\/([^/?#]+)/i)
  if (pub) return `linkedin.com/in/${pub[1].toLowerCase()}`

  const lead = url.match(/linkedin\.com\/sales\/lead\/([^/?#,]+)/i)
  if (lead) return `linkedin.com/sales/lead/${lead[1]}`

  return null
}

export async function findDuplicates(incoming: IncomingContact): Promise<DedupeMatch[]> {
  const matches: DedupeMatch[] = []

  const email = incoming.email ? normalizeEmail(incoming.email) : null
  if (email) {
    const exact = await db().contact.findFirst({ where: { email }, select: { id: true } })
    if (exact) {
      matches.push({ contactId: exact.id, confidence: 'exact', reason: 'Identical email address' })
      return matches // nothing beats an email match
    }
  }

  const li = normalizeLinkedIn(incoming.linkedinUrl)
  if (li) {
    const byLinkedIn = await db().contact.findFirst({
      where: { linkedinUrl: { contains: li, mode: 'insensitive' } },
      select: { id: true },
    })
    if (byLinkedIn) {
      matches.push({ contactId: byLinkedIn.id, confidence: 'exact', reason: 'Same LinkedIn profile' })
      return matches
    }
  }

  // Fuzzy: same surname within the same company.
  const domain = incoming.companyDomain ?? (email ? domainFromEmail(email) : null)
  if (incoming.lastName && domain) {
    const candidates = await db().contact.findMany({
      where: {
        lastName: { equals: incoming.lastName, mode: 'insensitive' },
        account: { domain },
      },
      select: { id: true, firstName: true, lastName: true },
      take: 10,
    })
    for (const c of candidates) {
      const sim = nameSimilarity(
        `${incoming.firstName ?? ''} ${incoming.lastName ?? ''}`,
        `${c.firstName ?? ''} ${c.lastName ?? ''}`
      )
      if (sim >= 0.85) {
        matches.push({ contactId: c.id, confidence: 'high', reason: `Same name at ${domain}` })
      } else if (sim >= 0.6) {
        matches.push({ contactId: c.id, confidence: 'probable', reason: `Similar name at ${domain}` })
      }
    }
  }

  return matches
}

/**
 * Merges `sourceId` into `targetId`. Non-null source fields fill target gaps;
 * the target's existing values always win. Related rows are repointed, then the
 * source is deleted.
 */
export async function mergeContacts(targetId: string, sourceId: string) {
  if (targetId === sourceId) throw new Error('Cannot merge a contact into itself')

  const [target, source] = await Promise.all([
    db().contact.findUniqueOrThrow({ where: { id: targetId } }),
    db().contact.findUniqueOrThrow({ where: { id: sourceId } }),
  ])

  const fill: Record<string, unknown> = {}
  const fields = [
    'email', 'firstName', 'lastName', 'title', 'phone', 'linkedinUrl',
    'timezone', 'country', 'city', 'accountId', 'apolloId', 'ownerId',
  ] as const

  for (const f of fields) {
    if (target[f] == null && source[f] != null) fill[f] = source[f]
  }

  // Engagement signals take the strongest value across both records.
  fill.score = Math.max(target.score, source.score)
  if (source.unsubscribedAt && !target.unsubscribedAt) fill.unsubscribedAt = source.unsubscribedAt
  if (source.bouncedAt && !target.bouncedAt) fill.bouncedAt = source.bouncedAt
  fill.customFields = { ...(source.customFields as object), ...(target.customFields as object) }

  await db().contact.update({ where: { id: targetId }, data: fill })

  await Promise.all([
    db().emailMessage.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } }),
    db().task.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } }),
    db().activity.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } }),
    db().deal.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } }),
  ])

  // Enrollments are unique on (sequenceId, contactId) — drop collisions rather than fail.
  const sourceEnrollments = await db().sequenceEnrollment.findMany({
    where: { contactId: sourceId },
    select: { id: true, sequenceId: true },
  })
  for (const e of sourceEnrollments) {
    const clash = await db().sequenceEnrollment.findFirst({
      where: { contactId: targetId, sequenceId: e.sequenceId },
      select: { id: true },
    })
    if (clash) {
      await db().sequenceEnrollment.delete({ where: { id: e.id } })
    } else {
      await db().sequenceEnrollment.update({ where: { id: e.id }, data: { contactId: targetId } })
    }
  }

  await db().contact.delete({ where: { id: sourceId } })
  return { targetId, mergedFields: Object.keys(fill) }
}
