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
        reason: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; '),
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

      const domain = tidyDomain(d.companyDomain) ?? (email ? domainFromEmail(email) ?? undefined : undefined)

      let accountId: string | null = null
      if (domain) {
        const cached = accountCache.get(domain)
        if (cached) accountId = cached
        else {
          const found = await db().account.findFirst({ where: { domain } })
          if (found) accountId = found.id
          else {
            const created = await db().account.create({
              data: { tenantId: tid(), name: d.companyName ?? domain, domain, country: d.country },
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
        if (found) accountId = found.id
        else {
          const created = await db().account.create({
            data: { tenantId: tid(), name: d.companyName, country: d.country },
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
