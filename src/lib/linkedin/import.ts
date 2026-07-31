import Papa from 'papaparse'
import { z } from 'zod'
import { db, tid } from '../db'
import { normalizeLinkedIn } from '../leads/dedupe'
import { normalizeEmail, domainFromEmail } from '../utils'
import { rescoreContact } from '../leads/scoring'
import { SALESNAV_FIELDS, SALESNAV_ALIASES, type SalesNavField } from './fields'

/**
 * Sales Navigator CSV import.
 *
 * A separate path from the generic CSV importer for one structural reason: Sales
 * Navigator exports usually have **no email address**. The generic importer keys
 * on email and rejects a row without one, which would throw away the entire file.
 *
 * Here the natural key is the LinkedIn profile URL, because it is the one field
 * that is stable across every way this data reaches us.
 *
 * **Where the file comes from.** Not from Sales Navigator. Sales Navigator has no
 * CSV export on any tier — Core, Advanced or Advanced Plus. LinkedIn omits it
 * deliberately, and there is no setting, plan or support request that turns it on.
 * An earlier version of this comment claimed the file was "a LinkedIn-provided
 * export"; that was wrong, and it sent at least one operator hunting for a button
 * that does not exist.
 *
 * The three ways a file legitimately gets here:
 *
 *   1. **Typed or pasted by hand.** A lead list is read off the screen into a
 *      spreadsheet. Slow, but it is the only path that needs nothing but a browser,
 *      and for a list of thirty it is twenty minutes.
 *   2. **Sales Navigator Advanced Plus → CRM sync → export from the CRM.** The
 *      paid answer LinkedIn actually sells. Advanced Plus writes leads into
 *      Salesforce or Dynamics; the CRM exports CSV. Our Salesforce connector reads
 *      the same data directly, which skips the file entirely.
 *   3. **Apollo (or another provider) searched by name and company.** The list is
 *      used as a shopping list rather than a source: the names come off
 *      LinkedIn by eye, and the provider supplies the profile URL, work email and
 *      company domain under its own licence.
 *
 * What is deliberately absent: any browser extension or service that reads
 * linkedin.com on the user's behalf. Those scrape, they breach LinkedIn's terms,
 * and the account they put at risk is the operator's own. This importer will never
 * be fed by one from inside this product.
 */

export { SALESNAV_FIELDS, type SalesNavField }
const ALIASES = SALESNAV_ALIASES

export type SalesNavParse = {
  headers: string[]
  rows: Record<string, string>[]
  suggested: Partial<Record<SalesNavField, string>>
  totalRows: number
}

export function parseSalesNav(text: string): SalesNavParse {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  const headers = result.meta.fields ?? []
  const rows = result.data.filter((r) => Object.values(r).some((v) => v?.trim()))

  const suggested: Partial<Record<SalesNavField, string>> = {}
  for (const h of headers) {
    const field = ALIASES[h.trim().toLowerCase()]
    if (field && !suggested[field]) suggested[field] = h
  }

  return { headers, rows, suggested, totalRows: rows.length }
}

const rowSchema = z.object({
  linkedinUrl: z.string().min(5).max(400),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  title: z.string().max(200).optional(),
  companyName: z.string().max(200).optional(),
  companyDomain: z.string().max(200).optional(),
  industry: z.string().max(120).optional(),
  employeeCount: z.string().max(40).optional(),
  email: z.string().max(254).optional(),
  city: z.string().max(160).optional(),
  country: z.string().max(100).optional(),
})

export type SalesNavResult = {
  dryRun: boolean
  total: number
  created: number
  updated: number
  duplicates: number
  skipped: number
  accountsCreated: number
  withoutEmail: number
  errors: { row: number; profile: string; reason: string }[]
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

/**
 * Turns Zod's issue list into something an operator can act on.
 *
 * The raw form reads `linkedinUrl: Required`, which names an internal field and
 * states a rule rather than a remedy. The overwhelmingly common case — a row with
 * an empty profile URL, because the person's URL was not to hand when the file was
 * built — deserves to say so, since that row is fixable in about five seconds and
 * the raw message does not suggest it is fixable at all.
 */
const FIELD_LABELS = new Map(SALESNAV_FIELDS.map((f) => [f.key as string, f.label.toLowerCase()]))

function humaniseIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const key = String(issue.path[0] ?? '')
      if (key === 'linkedinUrl') {
        return /required|expected string/i.test(issue.message)
          ? 'No profile URL — open the person on LinkedIn, copy the address, and put it in that column'
          : `Profile URL looks wrong: ${issue.message.toLowerCase()}`
      }
      const label = FIELD_LABELS.get(key)
      return label ? `${label}: ${issue.message.toLowerCase()}` : issue.message
    })
    .join('; ')
}

/**
 * Headcount as people actually write it down.
 *
 * Sales Navigator shows a band ("51-200 employees"), spreadsheets carry "1,200",
 * and a person typing by hand writes "~2500" or "2.5k". A plain `Number()` turns
 * every one of those into NaN, which would be stored as a null nobody could
 * explain — the column was mapped, the value was there, and the field came out
 * empty.
 *
 * A range takes its lower bound, deliberately. The draft bands on 50 and 1000, and
 * understating headcount picks the more modest opener, which is the safer error.
 */
export function parseHeadcount(v: string | undefined): number | undefined {
  if (!v) return undefined
  const cleaned = v.replace(/,/g, '').replace(/\s+/g, ' ').trim()

  // "51-200", "51 – 200", "1001+" → take the first number.
  const first = cleaned.match(/(\d+(?:\.\d+)?)\s*([km])?/i)
  if (!first) return undefined

  let n = Number(first[1])
  const unit = first[2]?.toLowerCase()
  if (unit === 'k') n *= 1_000
  else if (unit === 'm') n *= 1_000_000

  if (!Number.isFinite(n) || n <= 0) return undefined
  // Nobody employs a fraction of a person, and nobody employs ten million.
  return Math.min(Math.round(n), 10_000_000)
}

function tidyDomain(v: string | undefined): string | undefined {
  if (!v) return undefined
  return (
    v.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .split('?')[0] || undefined
  )
}

/**
 * Fills industry and headcount on an account that already exists.
 *
 * Without this, adding the columns would have been useless to anyone who had
 * already imported once: the account is matched, not created, so the new columns
 * would be read, mapped, reported as imported, and silently dropped — the same
 * failure as the wizard's missing fields, one layer down.
 *
 * Gaps only. A value already on the record was either curated by a human or set
 * by enrichment, and a CSV typed from a screen is not evidence enough to overwrite
 * either.
 */
async function backfillAccount(
  account: { id: string; industry: string | null; employeeCount: number | null },
  industry: string | undefined,
  headcount: number | undefined,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return
  const patch: { industry?: string; employeeCount?: number } = {}
  if (account.industry == null && industry != null) patch.industry = industry
  if (account.employeeCount == null && headcount != null) patch.employeeCount = headcount
  if (Object.keys(patch).length === 0) return
  await db().account.update({ where: { id: account.id }, data: patch })
}

export async function importSalesNav(opts: {
  rows: Record<string, string>[]
  mapping: Partial<Record<SalesNavField, string>>
  ownerId?: string | null
  listName?: string | null
  dryRun?: boolean
}): Promise<SalesNavResult> {
  const { rows, mapping, ownerId = null, listName = null, dryRun = false } = opts

  const result: SalesNavResult = {
    dryRun, total: rows.length, created: 0, updated: 0, duplicates: 0,
    skipped: 0, accountsCreated: 0, withoutEmail: 0, errors: [],
  }

  let listId: string | null = null
  if (listName && !dryRun) {
    const existing = await db().contactList.findFirst({ where: { name: listName } })
    listId = existing?.id ?? (await db().contactList.create({
      data: { tenantId: tid(), name: listName, description: 'Imported from Sales Navigator' },
    })).id
  }

  const accountCache = new Map<string, string>()
  const seen = new Set<string>()

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const rowNumber = i + 2

    const candidate: Record<string, string | undefined> = {}
    for (const f of SALESNAV_FIELDS) {
      const column = mapping[f.key]
      if (column) candidate[f.key] = clean(raw[column])
    }

    const parsed = rowSchema.safeParse(candidate)
    if (!parsed.success) {
      result.errors.push({
        row: rowNumber,
        profile: candidate.linkedinUrl ?? '',
        reason: humaniseIssues(parsed.error.issues),
      })
      result.skipped++
      continue
    }

    const d = parsed.data
    const normalized = normalizeLinkedIn(d.linkedinUrl)
    if (!normalized) {
      result.errors.push({
        row: rowNumber,
        profile: d.linkedinUrl,
        reason: 'Not a recognisable linkedin.com/in/ profile URL',
      })
      result.skipped++
      continue
    }

    if (seen.has(normalized)) {
      result.duplicates++
      result.errors.push({ row: rowNumber, profile: normalized, reason: 'Duplicate row within this file' })
      continue
    }
    seen.add(normalized)

    const email = d.email ? normalizeEmail(d.email) : undefined
    if (!email) result.withoutEmail++

    try {
      // Match on the profile URL first, then on email if the export happened to
      // carry one — otherwise a contact already known by email gets duplicated.
      const existing =
        (await db().contact.findFirst({
          where: { linkedinUrl: { contains: normalized, mode: 'insensitive' } },
        })) ?? (email ? await db().contact.findFirst({ where: { email } }) : null)

      const domain = tidyDomain(d.companyDomain) ?? (email ? domainFromEmail(email) ?? undefined : undefined)
      const headcount = parseHeadcount(d.employeeCount)

      if (existing) {
        result.duplicates++
        if (!dryRun) {
          const patch: Record<string, unknown> = {}
          if (!existing.linkedinUrl) patch.linkedinUrl = `https://${normalized}`
          for (const k of ['firstName', 'lastName', 'title', 'city', 'country'] as const) {
            if (existing[k] == null && d[k] != null) patch[k] = d[k]
          }
          if (!existing.email && email) patch.email = email
          if (Object.keys(patch).length) {
            await db().contact.update({ where: { id: existing.id }, data: patch })
          }

          // The company still gets looked at. Re-importing the same list with
          // Industry and Headcount added is the realistic way those columns get
          // used — you import, see thin drafts, add the columns, import again —
          // and this branch used to `continue` straight past the account, so the
          // second import reported success and changed nothing that mattered.
          const known = domain
            ? await db().account.findFirst({ where: { domain } })
            : d.companyName
              ? await db().account.findFirst({
                  where: { name: { equals: d.companyName, mode: 'insensitive' } },
                })
              : null
          if (known) {
            await backfillAccount(known, d.industry, headcount, dryRun)
            if (!existing.accountId) {
              await db().contact.update({
                where: { id: existing.id },
                data: { accountId: known.id },
              })
            }
          }

          if (listId) {
            await db().contactListMember.upsert({
              where: { listId_contactId: { listId, contactId: existing.id } },
              update: {},
              create: { listId, contactId: existing.id },
            })
          }
        }
        result.updated++
        continue
      }

      if (dryRun) {
        result.created++
        continue
      }

      let accountId: string | null = null
      if (domain) {
        const cached = accountCache.get(domain)
        if (cached) accountId = cached
        else {
          const found = await db().account.findFirst({ where: { domain } })
          if (found) {
            accountId = found.id
            await backfillAccount(found, d.industry, headcount, dryRun)
          } else {
            const created = await db().account.create({
              data: {
                tenantId: tid(), name: d.companyName ?? domain, domain, country: d.country,
                industry: d.industry, employeeCount: headcount,
              },
            })
            accountId = created.id
            result.accountsCreated++
          }
          accountCache.set(domain, accountId)
        }
      } else if (d.companyName) {
        // No domain in the export, which is common. Match on name so people at
        // the same company still group, rather than each becoming an orphan.
        const found = await db().account.findFirst({
          where: { name: { equals: d.companyName, mode: 'insensitive' } },
        })
        if (found) {
          accountId = found.id
          await backfillAccount(found, d.industry, headcount, dryRun)
        } else {
          const created = await db().account.create({
            data: {
              tenantId: tid(), name: d.companyName, country: d.country,
              industry: d.industry, employeeCount: headcount,
            },
          })
          accountId = created.id
          result.accountsCreated++
        }
      }

      const contact = await db().contact.create({
        data: {
          tenantId: tid(),
          email,
          firstName: d.firstName,
          lastName: d.lastName,
          title: d.title,
          linkedinUrl: `https://${normalized}`,
          city: d.city,
          country: d.country,
          accountId,
          ownerId,
          source: 'linkedin_csv',
        },
      })

      if (listId) {
        await db().contactListMember.create({ data: { listId, contactId: contact.id } })
      }

      await db().activity.create({
        data: {
          tenantId: tid(),
          type: 'field_change',
          summary: 'Imported from a Sales Navigator lead list',
          contactId: contact.id,
          accountId,
        },
      })

      await rescoreContact(contact.id)
      result.created++
    } catch (err) {
      result.errors.push({
        row: rowNumber,
        profile: normalized,
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
      result.skipped++
    }
  }

  return result
}
