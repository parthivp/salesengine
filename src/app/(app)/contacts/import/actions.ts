'use server'

import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { importContacts, type ColumnMapping, type ImportResult } from '@/lib/leads/import'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'
import { revalidatePath } from 'next/cache'

const MAX_ROWS = 5000

const schema = z.object({
  rows: z.array(z.record(z.string(), z.string())).max(MAX_ROWS),
  mapping: z.record(z.string(), z.string()),
  dryRun: z.boolean(),
  assignToMe: z.boolean().default(false),
  onDuplicate: z.enum(['skip', 'update']).default('update'),
  listName: z.string().trim().max(120).optional(),
})

export type ImportInput = z.input<typeof schema>

export type ImportActionResult =
  | { ok: true; result: ImportResult }
  | { ok: false; error: string }

export async function runImport(input: ImportInput): Promise<ImportActionResult> {
  const auth = await requirePermission('contact:create')

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.code === 'too_big'
          ? `This import is limited to ${MAX_ROWS.toLocaleString()} rows per file. Split the file and try again.`
          : (parsed.error.issues[0]?.message ?? 'Invalid import payload.'),
    }
  }

  const { rows, mapping, dryRun, assignToMe, onDuplicate, listName } = parsed.data

  if (!mapping.email) {
    return { ok: false, error: 'Map a column to Email before importing — it is the dedupe key.' }
  }

  try {
    const result = await withTenant(
      auth.tenant.id,
      async () => {
        let listId: string | null = null
        if (listName && !dryRun) {
          const existing = await db().contactList.findFirst({ where: { name: listName } })
          listId =
            existing?.id ??
            (await db().contactList.create({ data: { tenantId: tid(), name: listName } })).id
        }

        const r = await importContacts({
          rows,
          mapping: mapping as ColumnMapping,
          ownerId: assignToMe ? auth.user.id : null,
          listId,
          dryRun,
          onDuplicate,
          source: 'csv',
        })

        if (!dryRun) {
          await audit({
            actorId: auth.user.id,
            action: 'create',
            entity: 'ContactImport',
            after: {
              total: r.total, created: r.created, updated: r.updated,
              skipped: r.skipped, list: listName ?? null,
            },
          })
        }

        return r
      },
      // A 5,000-row import does real work; the default 15s is not enough.
      { timeout: 240_000 }
    )

    if (!dryRun) revalidatePath('/contacts')
    return { ok: true, result }
  } catch (err) {
    logger.error({ err }, 'CSV import failed')
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Import failed unexpectedly.',
    }
  }
}
