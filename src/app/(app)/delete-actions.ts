'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant } from '@/lib/db'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'
import {
  previewContactDelete, deleteContacts,
  previewAccountDelete, deleteAccount,
  previewSequenceDelete, deleteSequence,
  previewTemplateDelete, deleteTemplate,
  previewDealDelete, deleteDeal,
  previewMessageDelete, deleteMessages,
  type DeletePreview,
} from '@/lib/delete'

/**
 * One place for deletes, rather than one per page.
 *
 * Every entity needs the same three things — a permission check, a preview the
 * confirmation can quote, and an audit entry — and five copies of that is five
 * chances to omit the audit on the one that matters.
 *
 * The preview and the delete are separate round trips on purpose. The
 * confirmation has to state what will actually go, and computing that at click
 * time means the numbers are current rather than whatever they were when the page
 * rendered.
 */

export type DeleteKind = 'contact' | 'account' | 'sequence' | 'template' | 'deal' | 'message'

/** Permission and audit entity per kind, so neither can drift from the other. */
const KINDS = {
  contact: { permission: 'contact:delete', entity: 'Contact', path: '/contacts' },
  account: { permission: 'account:delete', entity: 'Account', path: '/accounts' },
  sequence: { permission: 'sequence:delete', entity: 'Sequence', path: '/sequences' },
  template: { permission: 'template:delete', entity: 'EmailTemplate', path: '/templates' },
  deal: { permission: 'deal:delete', entity: 'Deal', path: '/deals' },
  message: { permission: 'message:delete', entity: 'EmailMessage', path: '/inbox' },
} as const

const schema = z.object({
  kind: z.enum(['contact', 'account', 'sequence', 'template', 'deal', 'message']),
  ids: z.array(z.string().min(1)).min(1).max(500),
  /** Options the dialog offered and the operator accepted. */
  cascadeContacts: z.boolean().optional(),
})

export type DeleteResult =
  | { ok: true; deleted: number }
  | { ok: false; error: string }

export async function previewDelete(
  input: z.input<typeof schema>
): Promise<{ ok: true; preview: DeletePreview } | { ok: false; error: string }> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Nothing selected.' }
  const { kind, ids, cascadeContacts } = parsed.data

  const auth = await requirePermission(KINDS[kind].permission)

  try {
    const preview = await withTenant(auth.tenant.id, async () => {
      switch (kind) {
        case 'contact': return previewContactDelete(ids)
        case 'account': return previewAccountDelete(ids[0], { cascadeContacts })
        case 'sequence': return previewSequenceDelete(ids[0])
        case 'template': return previewTemplateDelete(ids[0])
        case 'deal': return previewDealDelete(ids[0])
        case 'message': return previewMessageDelete(ids)
      }
    })
    return { ok: true, preview }
  } catch (err) {
    logger.error({ err, kind }, 'delete preview failed')
    return { ok: false, error: 'Could not work out what deleting that would remove.' }
  }
}

export async function confirmDelete(input: z.input<typeof schema>): Promise<DeleteResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Nothing selected.' }
  const { kind, ids, cascadeContacts } = parsed.data

  const auth = await requirePermission(KINDS[kind].permission)

  try {
    // Re-checked here, not just before the dialog opened. A campaign can go from
    // paused to active while a confirmation sits on screen, and the button the
    // operator is looking at was rendered against the older answer.
    const blocked = await withTenant(auth.tenant.id, async () => {
      switch (kind) {
        case 'sequence': return (await previewSequenceDelete(ids[0])).blockers
        case 'contact': return (await previewContactDelete(ids)).blockers
        default: return []
      }
    })
    if (blocked.length) return { ok: false, error: blocked[0] }

    const deleted = await withTenant(auth.tenant.id, async () => {
      switch (kind) {
        case 'contact': return (await deleteContacts(ids)).deleted
        case 'account': {
          // Deleting the company's people counts as deleting them, so the number
          // reported back is the number of records that actually went.
          const r = await deleteAccount(ids[0], { cascadeContacts })
          return 1 + r.contactsDeleted
        }
        case 'sequence': await deleteSequence(ids[0]); return 1
        case 'template': await deleteTemplate(ids[0]); return 1
        case 'deal': await deleteDeal(ids[0]); return 1
        case 'message': return (await deleteMessages(ids)).deleted
      }
    })

    // Audited per id. A bulk delete of forty contacts that leaves one audit row
    // saying "40 contacts" cannot answer "was this one of them?", which is the
    // only question anybody asks of an audit log afterwards.
    for (const id of ids) {
      await audit({
        actorId: auth.user.id,
        action: 'delete',
        entity: KINDS[kind].entity,
        entityId: id,
        before: { deleted: true },
      })
    }

    revalidatePath(KINDS[kind].path)
    revalidatePath('/dashboard')
    logger.info({ kind, count: deleted, actorId: auth.user.id }, 'records deleted')
    return { ok: true, deleted }
  } catch (err) {
    logger.error({ err, kind }, 'delete failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not delete that.' }
  }
}
