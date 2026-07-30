import Papa from 'papaparse'
import { z } from 'zod'
import { db, tid } from '../db'
import { normalizeEmail, domainFromEmail } from '../utils'
import { findDuplicates } from './dedupe'
import { rescoreContact } from './scoring'

/**
 * CSV import.
 *
 * Design constraints that come from experience rather than taste:
 *   - a dry run must be possible, because the alternative is a customer pasting
 *     4,000 malformed rows into their production contact list;
 *   - one bad row must not abort the batch;
 *   - the error report must be downloadable, row-numbered, and specific.
 */

export const IMPORT_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'title', label: 'Job title' },
  { key: 'phone', label: 'Phone' },
  { key: 'linkedinUrl', label: 'LinkedIn URL' },
  { key: 'companyName', label: 'Company name' },
  { key: 'companyDomain', label: 'Company domain' },
  { key: 'country', label: 'Country' },
  { key: 'city', label: 'City' },
] as const

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']

/** Column name -> field. Covers Apollo, Sales Navigator and HubSpot exports. */
const HEADER_ALIASES: Record<string, ImportFieldKey> = {
  email: 'email', 'email address': 'email', 'work email': 'email',
  'e-mail': 'email', 'primary email': 'email', 'email 1': 'email',
  'first name': 'firstName', firstname: 'firstName', 'given name': 'firstName',
  'last name': 'lastName', lastname: 'lastName', surname: 'lastName', 'family name': 'lastName',
  title: 'title', 'job title': 'title', position: 'title', 'job position': 'title', headline: 'title',
  phone: 'phone', 'phone number': 'phone', 'mobile phone': 'phone', 'work direct phone': 'phone',
  linkedin: 'linkedinUrl', 'linkedin url': 'linkedinUrl', 'person linkedin url': 'linkedinUrl',
  'profile url': 'linkedinUrl',
  company: 'companyName', 'company name': 'companyName', organization: 'companyName',
  account: 'companyName', employer: 'companyName',
  domain: 'companyDomain', website: 'companyDomain', 'company domain': 'companyDomain',
  'company website': 'companyDomain', 'primary domain': 'companyDomain',
  country: 'country', city: 'city', 'company city': 'city', 'company country': 'country',
}

export type ColumnMapping = Partial<Record<ImportFieldKey, string>>

export type ParsedCsv = {
  headers: string[]
  rows: Record<string, string>[]
  suggested: ColumnMapping
  totalRows: number
}

export function parseCsv(text: string, sampleLimit = 0): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  const headers = result.meta.fields ?? []
  const rows = result.data.filter((r) => Object.values(r).some((v) => v?.trim()))

  const suggested: ColumnMapping = {}
  for (const h of headers) {
    const field = HEADER_ALIASES[h.trim().toLowerCase()]
    if (field && !suggested[field]) suggested[field] = h
  }

  return {
    headers,
    rows: sampleLimit ? rows.slice(0, sampleLimit) : rows,
    suggested,
    totalRows: rows.length,
  }
}

const rowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  title: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  linkedinUrl: z.string().max(400).optional(),
  companyName: z.string().max(200).optional(),
  companyDomain: z.string().max(200).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(120).optional(),
})

export type RowError = { row: number; email: string; reason: string }

export type ImportResult = {
  dryRun: boolean
  total: number
  created: number
  updated: number
  duplicates: number
  skipped: number
  accountsCreated: number
  errors: RowError[]
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

function tidyDomain(v: string | undefined): string | undefined {
  if (!v) return undefined
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0] || undefined
}

export async function importContacts(opts: {
  rows: Record<string, string>[]
  mapping: ColumnMapping
  ownerId?: string | null
  listId?: string | null
  dryRun?: boolean
  source?: string
  onDuplicate?: 'skip' | 'update'
}): Promise<ImportResult> {
  const {
    rows, mapping, ownerId = null, listId = null,
    dryRun = false, source = 'csv', onDuplicate = 'update',
  } = opts

  const result: ImportResult = {
    dryRun, total: rows.length, created: 0, updated: 0,
    duplicates: 0, skipped: 0, accountsCreated: 0, errors: [],
  }

  // Cache domain -> accountId so a 5,000-row file does not issue 5,000 lookups.
  const accountCache = new Map<string, string>()
  const seenEmails = new Set<string>()

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const rowNumber = i + 2 // +1 for zero-index, +1 for the header line

    const candidate: Record<string, string | undefined> = {}
    for (const field of IMPORT_FIELDS) {
      const column = mapping[field.key]
      if (column) candidate[field.key] = clean(raw[column])
    }

    const parsed = rowSchema.safeParse(candidate)
    if (!parsed.success) {
      result.errors.push({
        row: rowNumber,
        email: candidate.email ?? '',
        reason: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; '),
      })
      result.skipped++
      continue
    }

    const data = parsed.data
    const email = normalizeEmail(data.email)

    // Duplicates inside the same file, not just against the database.
    if (seenEmails.has(email)) {
      result.duplicates++
      result.errors.push({ row: rowNumber, email, reason: 'Duplicate row within this file' })
      continue
    }
    seenEmails.add(email)

    const domain = tidyDomain(data.companyDomain) ?? domainFromEmail(email) ?? undefined

    try {
      const existing = await findDuplicates({
        email,
        firstName: data.firstName,
        lastName: data.lastName,
        linkedinUrl: data.linkedinUrl,
        companyDomain: domain,
      })

      const exact = existing.find((m) => m.confidence === 'exact')

      if (exact) {
        result.duplicates++
        if (onDuplicate === 'skip') {
          result.skipped++
          continue
        }
        if (!dryRun) {
          // Fill gaps only — never clobber a value a human has curated.
          const current = await db().contact.findUniqueOrThrow({ where: { id: exact.contactId } })
          const patch: Record<string, unknown> = {}
          for (const k of ['firstName', 'lastName', 'title', 'phone', 'linkedinUrl', 'country', 'city'] as const) {
            if (current[k] == null && data[k] != null) patch[k] = data[k]
          }
          if (Object.keys(patch).length) {
            await db().contact.update({ where: { id: exact.contactId }, data: patch })
          }
          if (listId) {
            await db().contactListMember.upsert({
              where: { listId_contactId: { listId, contactId: exact.contactId } },
              update: {},
              create: { listId, contactId: exact.contactId },
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

      // --- account ---------------------------------------------------------
      let accountId: string | null = null
      if (domain) {
        const cached = accountCache.get(domain)
        if (cached) {
          accountId = cached
        } else {
          // find-then-create rather than upsert: the composite unique is
          // (tenantId, domain), and RLS already constrains the read to this
          // tenant, so a plain domain lookup is both correct and simpler.
          const found = await db().account.findFirst({ where: { domain } })
          if (found) {
            accountId = found.id
          } else {
            const created = await db().account.create({
              data: {
                tenantId: tid(),
                name: data.companyName ?? domain,
                domain,
                country: data.country,
              },
            })
            accountId = created.id
            result.accountsCreated++
          }
          accountCache.set(domain, accountId)
        }
      }

      const contact = await db().contact.create({
        data: {
          tenantId: tid(),
          email,
          firstName: data.firstName,
          lastName: data.lastName,
          title: data.title,
          phone: data.phone,
          linkedinUrl: data.linkedinUrl,
          country: data.country,
          city: data.city,
          accountId,
          ownerId,
          source,
        },
      })

      if (listId) {
        await db().contactListMember.create({ data: { listId, contactId: contact.id } })
      }

      await db().activity.create({
        data: {
          tenantId: contact.tenantId,
          type: 'field_change',
          summary: `Imported from ${source.toUpperCase()}`,
          contactId: contact.id,
          accountId,
        },
      })

      await rescoreContact(contact.id)
      result.created++
    } catch (err) {
      result.errors.push({
        row: rowNumber,
        email,
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
      result.skipped++
    }
  }

  return result
}

/** Row-numbered CSV the user can open in Excel and fix. */
export function errorsToCsv(errors: RowError[]): string {
  return Papa.unparse(
    errors.map((e) => ({ Row: e.row, Email: e.email, Problem: e.reason })),
    { header: true }
  )
}
