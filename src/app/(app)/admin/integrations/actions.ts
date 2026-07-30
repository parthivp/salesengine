'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { SALESFORCE_DEFAULTS, validateMappings } from '@/lib/crm/mapping'
import { audit } from '@/lib/audit'
import { enqueue } from '@/lib/queue'
import { env } from '@/lib/env'
import { generateToken } from '@/lib/crypto'
import { salesforceAdapter } from '@/lib/crm/salesforce'
import { salesforceConfigured } from '@/lib/crm/config'

export type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

/**
 * Starts the OAuth flow. The state token is stored against the tenant so the
 * callback cannot be replayed against a different workspace.
 */
export async function beginConnect(provider: 'salesforce'): Promise<Result<{ url: string }>> {
  const auth = await requirePermission('integration:update')
  if (!salesforceConfigured()) {
    return {
      ok: false,
      error:
        'Salesforce is not configured on this deployment. Add SALESFORCE_CLIENT_ID and ' +
        'SALESFORCE_CLIENT_SECRET from a Salesforce Connected App, then restart.',
    }
  }

  const state = generateToken(24)

  try {
    await withTenant(auth.tenant.id, async () => {
      const existing = await db().crmConnection.findFirst({ where: { provider } })
      const payload = { oauthState: state, oauthStartedAt: new Date().toISOString() }
      if (existing) {
        await db().crmConnection.update({
          where: { id: existing.id },
          data: { credentials: { ...(existing.credentials as object), ...payload } as never },
        })
      } else {
        await db().crmConnection.create({
          data: { tenantId: tid(), provider, status: 'disconnected', credentials: payload as never },
        })
      }
    })

    return {
      ok: true,
      data: {
        url: salesforceAdapter.authorizeUrl({
          redirectUri: `${env.APP_URL}/api/crm/salesforce/callback`,
          state: `${auth.tenant.id}:${state}`,
        }),
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not start the connection.' }
  }
}

export async function applyDefaultMappings(connectionId: string): Promise<Result<{ created: number }>> {
  const auth = await requirePermission('integration:update')

  try {
    const created = await withTenant(auth.tenant.id, async () => {
      await db().crmConnection.findUniqueOrThrow({ where: { id: connectionId } })
      let n = 0
      for (const m of SALESFORCE_DEFAULTS) {
        const existing = await db().crmFieldMapping.findFirst({
          where: { connectionId, object: m.object, localField: m.localField, remoteField: m.remoteField },
        })
        if (existing) continue
        await db().crmFieldMapping.create({
          data: {
            connectionId,
            object: m.object,
            localField: m.localField,
            remoteField: m.remoteField,
            direction: m.direction,
            transform: m.transform ?? null,
            transformConfig: (m.transformConfig ?? {}) as never,
          },
        })
        n++
      }
      await audit({ actorId: auth.user.id, action: 'update', entity: 'CrmFieldMapping', after: { created: n } })
      return n
    })

    revalidatePath('/admin/integrations')
    return { ok: true, data: { created } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not apply the defaults.' }
  }
}

export async function setConflictPolicy(
  connectionId: string,
  policy: 'last_write_wins' | 'crm_wins' | 'app_wins' | 'manual'
): Promise<Result> {
  const auth = await requirePermission('integration:update')
  try {
    await withTenant(auth.tenant.id, async () => {
      const conn = await db().crmConnection.findUniqueOrThrow({ where: { id: connectionId } })
      await db().crmConnection.update({
        where: { id: connectionId },
        data: { credentials: { ...(conn.credentials as object), conflictPolicy: policy } as never },
      })
    })
    revalidatePath('/admin/integrations')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the policy.' }
  }
}

export async function toggleSync(connectionId: string, enabled: boolean): Promise<Result> {
  const auth = await requirePermission('integration:update')
  try {
    await withTenant(auth.tenant.id, () =>
      db().crmConnection.update({ where: { id: connectionId }, data: { syncEnabled: enabled } })
    )
    revalidatePath('/admin/integrations')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not update sync.' }
  }
}

export async function runSyncNow(connectionId: string): Promise<Result> {
  const auth = await requirePermission('integration:update')
  try {
    const mappingCount = await withTenant(auth.tenant.id, async () => {
      await db().crmConnection.findUniqueOrThrow({ where: { id: connectionId } })
      return db().crmFieldMapping.count({ where: { connectionId } })
    })
    if (!mappingCount) {
      return { ok: false, error: 'Map at least one field before syncing.' }
    }
    await enqueue('crm:sync', { tenantId: auth.tenant.id, connectionId })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not queue the sync.' }
  }
}

export async function resolveConflictRecord(
  syncRecordId: string,
  winner: 'app' | 'crm'
): Promise<Result> {
  const auth = await requirePermission('integration:update')
  try {
    await withTenant(auth.tenant.id, async () => {
      const record = await db().crmSyncRecord.findFirstOrThrow({
        where: { id: syncRecordId, connection: { tenantId: auth.tenant.id } },
      })
      // Clearing the opposite side's hash makes the next pass see that side as
      // changed, so the chosen winner propagates through the normal path rather
      // than a special-case write.
      await db().crmSyncRecord.update({
        where: { id: record.id },
        data: {
          conflictAt: null,
          lastError: null,
          ...(winner === 'app' ? { remoteHash: null } : { localHash: null }),
        },
      })
      await audit({
        actorId: auth.user.id, action: 'update', entity: 'CrmSyncRecord',
        entityId: record.id, after: { resolvedInFavourOf: winner },
      })
    })
    revalidatePath('/admin/integrations')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not resolve the conflict.' }
  }
}

export async function validateConnectionMappings(connectionId: string): Promise<Result<{ problems: string[] }>> {
  const auth = await requirePermission('integration:read')
  try {
    const problems = await withTenant(auth.tenant.id, async () => {
      const rows = await db().crmFieldMapping.findMany({ where: { connectionId } })
      const objects = [...new Set(rows.map((r) => r.object))]
      const all: string[] = []
      for (const object of objects) {
        all.push(
          ...validateMappings(
            object as never,
            rows.map((m) => ({
              object: m.object as never,
              localField: m.localField,
              remoteField: m.remoteField,
              direction: m.direction as never,
            }))
          )
        )
      }
      return all
    })
    return { ok: true, data: { problems } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Validation failed.' }
  }
}
