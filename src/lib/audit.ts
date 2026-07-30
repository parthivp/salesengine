import { db, currentTenantId } from './db'
import type { AuditAction } from '@prisma/client'
import { logger } from './logger'

/**
 * Append-only trail. Never throws into the caller: an audit failure must not
 * roll back the business operation it was recording, but it must be visible.
 */
export async function audit(entry: {
  actorId?: string | null
  action: AuditAction
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
}) {
  const tenantId = currentTenantId()
  if (!tenantId) {
    logger.warn({ entry }, 'audit() called outside a tenant context; skipped')
    return
  }
  try {
    await db().auditLog.create({
      data: {
        tenantId,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: (entry.before ?? undefined) as never,
        after: (entry.after ?? undefined) as never,
        ip: entry.ip ?? null,
      },
    })
  } catch (err) {
    logger.error({ err, entry }, 'failed to write audit log')
  }
}

/** Field-level diff so audit rows stay small and readable. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key]
      a[key] = after[key]
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 }
}
