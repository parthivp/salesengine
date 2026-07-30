import { withTenant, db, prismaAdmin } from '../../lib/db'
import { logger } from '../../lib/logger'
import { unsealObject, sealObject, type Sealed } from '../../lib/crypto'
import { salesforceAdapter } from '../../lib/crm/salesforce'
import { pullObject, pushObject, syncConnection } from '../../lib/crm/sync'
import { CrmAuthError, type CrmAdapter, type CrmConnectionContext, type CrmObject } from '../../lib/crm/types'
import type { FieldMapping, ConflictPolicy, SyncDirection } from '../../lib/crm/mapping'

/**
 * CRM sync jobs.
 *
 * The one thing this layer owns that the engine does not: token lifecycle.
 * Access tokens die, and every provider signals it the same way — a 401 mid-sync.
 * So the pattern is: attempt, catch CrmAuthError once, refresh, retry, and only
 * then mark the connection as expired for a human to reconnect.
 */

const ADAPTERS: Record<string, CrmAdapter> = {
  salesforce: salesforceAdapter,
}

export function adapterFor(provider: string): CrmAdapter {
  const adapter = ADAPTERS[provider]
  if (!adapter) throw new Error(`No CRM adapter registered for "${provider}".`)
  return adapter
}

type StoredCredentials = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  conflictPolicy?: ConflictPolicy
  sealed?: Sealed
}

/**
 * Builds a connection context, decrypting credentials at the last moment.
 * Tokens live encrypted at rest; a database dump must not hand over live access
 * to every tenant's CRM.
 */
async function contextFor(connectionId: string, tenantId: string): Promise<{
  ctx: CrmConnectionContext
  adapter: CrmAdapter
  policy: ConflictPolicy
}> {
  const connection = await prismaAdmin.crmConnection.findUniqueOrThrow({
    where: { id: connectionId },
  })

  const stored = (connection.credentials ?? {}) as StoredCredentials
  const secrets = stored.sealed
    ? unsealObject<{ accessToken: string; refreshToken?: string }>(stored.sealed)
    : { accessToken: stored.accessToken ?? '', refreshToken: stored.refreshToken }

  if (!secrets.accessToken) {
    throw new CrmAuthError('Connection has no access token; reconnect required.')
  }

  return {
    adapter: adapterFor(connection.provider),
    policy: stored.conflictPolicy ?? 'last_write_wins',
    ctx: {
      connectionId,
      tenantId,
      instanceUrl: connection.instanceUrl ?? undefined,
      accessToken: secrets.accessToken,
      refreshToken: secrets.refreshToken,
      expiresAt: stored.expiresAt ? new Date(stored.expiresAt) : undefined,
    },
  }
}

async function persistTokens(
  connectionId: string,
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: Date; instanceUrl?: string }
) {
  const connection = await prismaAdmin.crmConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const stored = (connection.credentials ?? {}) as StoredCredentials

  await prismaAdmin.crmConnection.update({
    where: { id: connectionId },
    data: {
      instanceUrl: tokens.instanceUrl ?? connection.instanceUrl,
      status: 'connected',
      credentials: {
        conflictPolicy: stored.conflictPolicy ?? 'last_write_wins',
        expiresAt: tokens.expiresAt?.toISOString(),
        sealed: sealObject({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? stored.refreshToken,
        }),
      } as never,
    },
  })
}

/** Runs `fn`, refreshing the access token once if the provider rejects it. */
async function withFreshToken<T>(
  connectionId: string,
  tenantId: string,
  fn: (ctx: CrmConnectionContext, adapter: CrmAdapter, policy: ConflictPolicy) => Promise<T>
): Promise<T> {
  const first = await contextFor(connectionId, tenantId)

  try {
    return await fn(first.ctx, first.adapter, first.policy)
  } catch (err) {
    if (!(err instanceof CrmAuthError) || !first.ctx.refreshToken) {
      if (err instanceof CrmAuthError) {
        await prismaAdmin.crmConnection.update({
          where: { id: connectionId },
          data: { status: 'expired', lastError: err.message },
        })
      }
      throw err
    }

    logger.info({ connectionId }, 'CRM access token rejected; refreshing')
    const tokens = await first.adapter.refresh(first.ctx.refreshToken)
    await persistTokens(connectionId, tokens)

    const second = await contextFor(connectionId, tenantId)
    return fn(second.ctx, second.adapter, second.policy)
  }
}

async function mappingsFor(connectionId: string): Promise<FieldMapping[]> {
  const rows = await db().crmFieldMapping.findMany({ where: { connectionId } })
  return rows.map((m) => ({
    object: m.object as CrmObject,
    localField: m.localField,
    remoteField: m.remoteField,
    direction: m.direction as SyncDirection,
    transform: (m.transform ?? undefined) as FieldMapping['transform'],
    transformConfig: (m.transformConfig ?? {}) as Record<string, unknown>,
  }))
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

export async function crmPull({
  tenantId,
  connectionId,
  object,
}: {
  tenantId: string
  connectionId: string
  object: string
}) {
  return withFreshToken(connectionId, tenantId, (ctx, adapter, policy) =>
    withTenant(
      tenantId,
      async () => {
        const mappings = await mappingsFor(connectionId)
        const stats = await pullObject({
          adapter,
          ctx,
          mappings,
          policy,
          object: object as CrmObject,
          direction: 'bidirectional',
        })
        logger.info({ connectionId, ...stats }, 'CRM pull complete')
        return stats
      },
      { timeout: 300_000 }
    )
  )
}

export async function crmPush({
  tenantId,
  connectionId,
  object,
  localIds,
}: {
  tenantId: string
  connectionId: string
  object: string
  localIds: string[]
}) {
  return withFreshToken(connectionId, tenantId, (ctx, adapter) =>
    withTenant(
      tenantId,
      async () => {
        const mappings = await mappingsFor(connectionId)
        const stats = await pushObject({
          adapter,
          ctx,
          mappings,
          localIds,
          object: object as CrmObject,
          direction: 'bidirectional',
        })
        logger.info({ connectionId, ...stats }, 'CRM push complete')
        return stats
      },
      { timeout: 300_000 }
    )
  )
}

/** Full sync for one connection. Driven by the scheduled job below. */
export async function crmSyncAll({
  tenantId,
  connectionId,
}: {
  tenantId: string
  connectionId: string
}) {
  return withFreshToken(connectionId, tenantId, (ctx, adapter) =>
    withTenant(
      tenantId,
      async () => {
        // Accounts first so contacts can attach to their company.
        const stats = await syncConnection({
          adapter, ctx, objects: ['account', 'contact', 'lead'],
        })
        logger.info({ connectionId, objects: stats.length }, 'CRM full sync complete')
        return stats
      },
      { timeout: 600_000 }
    )
  )
}

/** Enqueues a sync for every enabled connection. Runs on a schedule. */
export async function crmSyncDue() {
  const connections = await prismaAdmin.crmConnection.findMany({
    where: { syncEnabled: true, status: { in: ['connected', 'error'] } },
    select: { id: true, tenantId: true, provider: true },
  })

  const { enqueue } = await import('../../lib/queue')
  for (const c of connections) {
    await enqueue(
      'crm:sync',
      { tenantId: c.tenantId, connectionId: c.id },
      { jobId: `crm:sync:${c.id}:${Math.floor(Date.now() / 900_000)}` }
    )
  }

  if (connections.length) logger.info({ count: connections.length }, 'CRM syncs enqueued')
  return { enqueued: connections.length }
}

/**
 * Writes an email or call to the CRM's activity timeline.
 *
 * Best-effort by design: a failed activity log must not fail the email send that
 * produced it. It is logged and dropped rather than retried forever.
 */
export async function crmLogActivity({
  tenantId,
  connectionId,
  contactId,
  type,
  subject,
  body,
  occurredAt,
}: {
  tenantId: string
  connectionId: string
  contactId: string
  type: 'email' | 'call' | 'task' | 'note'
  subject: string
  body?: string
  occurredAt: string
}) {
  return withFreshToken(connectionId, tenantId, (ctx, adapter) =>
    withTenant(tenantId, async () => {
      const link = await db().crmSyncRecord.findFirst({
        where: { connectionId, object: 'contact', localId: contactId },
      })
      if (!link) return { skipped: 'contact_not_synced' }

      const result = await adapter.logActivity(ctx, {
        remoteRecordId: link.remoteId,
        object: 'contact',
        type,
        subject,
        body,
        occurredAt: new Date(occurredAt),
      })

      if (!result.ok) logger.warn({ connectionId, contactId, error: result.error }, 'activity log failed')
      return result
    })
  )
}
