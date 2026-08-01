'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant } from '@/lib/db'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'
import { parseSalesNavigator, type ParsedLead } from '@/lib/linkedin/parse-salesnav'
import { importSalesNav, type SalesNavResult } from '@/lib/linkedin/import'
import type { SalesNavField } from '@/lib/linkedin/fields'

/**
 * Reading a page you saved, and importing what you confirm.
 *
 * Parsing happens on the server, not in the browser: the HTML parser is a large
 * dependency and the file is most of a megabyte, so doing it here keeps both out of
 * the page you are using. Nothing is written by `readPage` — it returns rows for
 * you to look at, and only `importParsed` touches the database.
 */

const MAX_HTML = 12_000_000

export type ReadResult =
  | { ok: true; kind: string; leads: ParsedLead[]; warnings: string[] }
  | { ok: false; error: string }

export async function readPage(html: string): Promise<ReadResult> {
  await requirePermission('contact:create')

  if (typeof html !== 'string' || html.trim().length < 200) {
    return { ok: false, error: 'That does not look like a saved page. Pick the .html file you saved.' }
  }
  if (html.length > MAX_HTML) {
    return { ok: false, error: 'That file is too large to read here. Save a single page rather than an archive.' }
  }

  try {
    const page = parseSalesNavigator(html)
    if (page.leads.length === 0) {
      return {
        ok: false,
        error:
          page.warnings[0] ??
          'No people were found in that page. Save it from Sales Navigator with Ctrl+S, choosing “Webpage, Complete”.',
      }
    }
    return { ok: true, kind: page.kind, leads: page.leads, warnings: page.warnings }
  } catch (err) {
    logger.error({ err }, 'sales navigator parse failed')
    return { ok: false, error: 'That page could not be read. It may be a saved copy of a different screen.' }
  }
}

// The reviewed rows come back from the browser rather than being re-parsed, because
// what is imported must be exactly what was on screen when the button was pressed —
// including any cell that was corrected by hand.
const rowSchema = z.object({
  linkedinUrl: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
  city: z.string().optional(),
  email: z.string().optional(),
  industry: z.string().optional(),
  employeeCount: z.string().optional(),
})

const schema = z.object({
  rows: z.array(rowSchema).min(1).max(500),
  listName: z.string().trim().max(120).optional(),
  assignToMe: z.boolean().default(true),
  dryRun: z.boolean().default(false),
})

export type ImportParsedResult =
  | { ok: true; result: SalesNavResult }
  | { ok: false; error: string }

export async function importParsed(input: z.input<typeof schema>): Promise<ImportParsedResult> {
  const auth = await requirePermission('contact:create')

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Nothing to import.' }
  }
  const { rows, listName, assignToMe, dryRun } = parsed.data

  // The rows are already keyed by field name, so the mapping is the identity — the
  // step a CSV needs because its columns are named by whoever made the file.
  const mapping = Object.fromEntries(
    (Object.keys(rowSchema.shape) as SalesNavField[]).map((k) => [k, k])
  ) as Partial<Record<SalesNavField, string>>

  try {
    const result = await withTenant(
      auth.tenant.id,
      async () => {
        const r = await importSalesNav({
          rows: rows as unknown as Record<string, string>[],
          mapping,
          ownerId: assignToMe ? auth.user.id : null,
          listName: listName ?? null,
          dryRun,
        })

        if (!dryRun) {
          await audit({
            actorId: auth.user.id,
            action: 'create',
            entity: 'ContactImport',
            after: {
              source: 'sales_navigator_page',
              total: r.total, created: r.created, updated: r.updated,
              duplicates: r.duplicates, list: listName ?? null,
            },
          })
        }
        return r
      },
      { timeout: 120_000 }
    )

    if (!dryRun) {
      revalidatePath('/contacts')
      revalidatePath('/linkedin')
    }
    return { ok: true, result }
  } catch (err) {
    logger.error({ err }, 'import from parsed page failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Import failed unexpectedly.' }
  }
}
