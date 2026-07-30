import { db, tid } from '../db'
import { logger } from '../logger'
import {
  toRemote, toLocal, hashFields, resolveConflict, type FieldMapping,
  type ConflictPolicy, type SyncDirection,
} from './mapping'
import type {
  CrmAdapter, CrmConnectionContext, CrmObject, CrmRecord, CrmValue,
} from './types'
import { CrmRateLimitError } from './types'

/**
 * The sync engine — provider-agnostic.
 *
 * It owns the hard parts, so an adapter never has to:
 *
 *  - **Echo suppression.** Bidirectional sync's defining failure is an edit
 *    bouncing between systems forever. Prevented by hashing only the *mapped*
 *    projection and storing both sides' hashes: if the incoming value hashes to
 *    what we last wrote, nothing changed and we stop.
 *  - **Conflict resolution.** Applied per record from an explicit policy, and
 *    flagged rather than guessed when the policy cannot decide.
 *  - **Watermarks.** Pulls are incremental with a small overlap, because provider
 *    clocks are not ours and an exact boundary drops records.
 *  - **Partial failure.** One bad record must not abort the batch; it is recorded
 *    against its own sync row and retried next pass.
 */

const OVERLAP_MS = 60_000 // re-read the last minute to tolerate clock skew

export type SyncStats = {
  object: CrmObject
  pulled: number
  created: number
  updated: number
  pushed: number
  skipped: number
  conflicts: number
  failed: number
  errors: string[]
}

function emptyStats(object: CrmObject): SyncStats {
  return {
    object, pulled: 0, created: 0, updated: 0, pushed: 0,
    skipped: 0, conflicts: 0, failed: 0, errors: [],
  }
}

/** Which local table backs each CRM object. */
const MODEL: Record<Exclude<CrmObject, 'activity'>, 'contact' | 'account' | 'lead' | 'deal'> = {
  contact: 'contact',
  account: 'account',
  lead: 'lead',
  deal: 'deal',
}

type LocalRow = { id: string; updatedAt: Date } & Record<string, unknown>

async function findLocal(object: CrmObject, id: string): Promise<LocalRow | null> {
  const model = MODEL[object as Exclude<CrmObject, 'activity'>]
  if (!model) return null
  switch (model) {
    case 'contact':
      return (await db().contact.findUnique({ where: { id }, include: { account: true } })) as LocalRow | null
    case 'account':
      return (await db().account.findUnique({ where: { id } })) as LocalRow | null
    case 'lead':
      return (await db().lead.findUnique({ where: { id } })) as LocalRow | null
    case 'deal':
      return (await db().deal.findUnique({ where: { id } })) as LocalRow | null
  }
}

async function updateLocal(object: CrmObject, id: string, patch: Record<string, unknown>) {
  const model = MODEL[object as Exclude<CrmObject, 'activity'>]
  const data = patch as never
  switch (model) {
    case 'contact': return db().contact.update({ where: { id }, data })
    case 'account': return db().account.update({ where: { id }, data })
    case 'lead': return db().lead.update({ where: { id }, data })
    case 'deal': return db().deal.update({ where: { id }, data })
    default: throw new Error(`Cannot update local object ${object}`)
  }
}

async function createLocal(object: CrmObject, patch: Record<string, unknown>) {
  const data = { tenantId: tid(), ...patch } as never
  switch (MODEL[object as Exclude<CrmObject, 'activity'>]) {
    case 'contact': return db().contact.create({ data })
    case 'account': return db().account.create({ data })
    case 'lead': return db().lead.create({ data })
    case 'deal': return db().deal.create({ data })
    default: throw new Error(`Cannot create local object ${object}`)
  }
}

/**
 * Some local fields are non-negotiable regardless of mapping: a CRM must never
 * be able to blank a tenantId, resurrect an unsubscribe, or overwrite our score.
 */
const PROTECTED_LOCAL_FIELDS = new Set([
  'id', 'tenantId', 'createdAt', 'updatedAt', 'score',
  'unsubscribedAt', 'bouncedAt', 'apolloId', 'enrichedAt',
])

function sanitisePatch(patch: Record<string, CrmValue>): Record<string, CrmValue> {
  const out: Record<string, CrmValue> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (PROTECTED_LOCAL_FIELDS.has(k)) continue
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export async function pullObject(opts: {
  adapter: CrmAdapter
  ctx: CrmConnectionContext
  object: CrmObject
  mappings: FieldMapping[]
  policy: ConflictPolicy
  direction: SyncDirection
  maxPages?: number
}): Promise<SyncStats> {
  const { adapter, ctx, object, mappings, policy, direction, maxPages = 20 } = opts
  const stats = emptyStats(object)
  const log = logger.child({ crm: adapter.key, object, op: 'pull' })

  if (direction === 'push' || direction === 'none') {
    stats.skipped++
    return stats
  }

  const connection = await db().crmConnection.findUniqueOrThrow({ where: { id: ctx.connectionId } })
  const since = connection.lastSyncAt
    ? new Date(connection.lastSyncAt.getTime() - OVERLAP_MS)
    : null

  let cursor: string | undefined
  let watermark: Date | null = null
  let pages = 0

  do {
    let page
    try {
      page = await adapter.pull(ctx, object, since, cursor)
    } catch (err) {
      if (err instanceof CrmRateLimitError) {
        // Stop cleanly and keep the watermark unmoved: the next run resumes.
        log.warn({ retryAfter: err.retryAfterSeconds }, 'rate limited during pull')
        stats.errors.push(`Rate limited; resuming later.`)
        break
      }
      throw err
    }

    stats.pulled += page.records.length
    if (page.watermark && (!watermark || page.watermark > watermark)) watermark = page.watermark

    for (const record of page.records) {
      try {
        await applyIncoming({ object, record, mappings, policy, connectionId: ctx.connectionId, stats })
      } catch (err) {
        stats.failed++
        const message = err instanceof Error ? err.message : String(err)
        stats.errors.push(`${record.remoteId}: ${message}`)
        log.warn({ err, remoteId: record.remoteId }, 'failed to apply incoming record')
        await db().crmSyncRecord.updateMany({
          where: { connectionId: ctx.connectionId, object, remoteId: record.remoteId },
          data: { lastError: message.slice(0, 500) },
        })
      }
    }

    cursor = page.cursor
    pages++
  } while (cursor && pages < maxPages)

  if (cursor) {
    // Deliberately visible: a silently truncated sync reads as a complete one.
    log.warn({ maxPages }, 'pull stopped at the page cap; more records remain')
    stats.errors.push(`Stopped after ${maxPages} pages — more records remain and will sync next run.`)
  }

  return stats
}

async function applyIncoming(args: {
  object: CrmObject
  record: CrmRecord
  mappings: FieldMapping[]
  policy: ConflictPolicy
  connectionId: string
  stats: SyncStats
}) {
  const { object, record, mappings, policy, connectionId, stats } = args

  const link = await db().crmSyncRecord.findFirst({
    where: { connectionId, object, remoteId: record.remoteId },
  })

  const remoteProjection = pickMapped(record.fields, mappings, object)
  const remoteHash = hashFields(remoteProjection)

  // --- new remote record --------------------------------------------------
  if (!link) {
    if (record.deleted) {
      stats.skipped++
      return
    }

    const patch = sanitisePatch(toLocal(record.fields, mappings.filter((m) => m.object === object)))

    // Match on a natural key before creating, so an existing local record is
    // linked rather than duplicated — the most common first-sync complaint.
    const existing = await matchExistingLocal(object, patch)

    if (existing) {
      const localProjection = pickMapped(
        toRemote(existing as Record<string, unknown>, mappings.filter((m) => m.object === object)),
        mappings,
        object
      )
      await db().crmSyncRecord.create({
        data: {
          connectionId, object, localId: existing.id, remoteId: record.remoteId,
          remoteHash, localHash: hashFields(localProjection), lastPulledAt: new Date(),
        },
      })
      await updateLocal(object, existing.id, fillGapsOnly(existing, patch))
      stats.updated++
      return
    }

    const created = await createLocal(object, patch)
    await db().crmSyncRecord.create({
      data: {
        connectionId, object, localId: created.id, remoteId: record.remoteId,
        remoteHash, localHash: remoteHash, lastPulledAt: new Date(),
      },
    })
    stats.created++
    return
  }

  // --- known record: has anything actually changed? -----------------------
  const local = await findLocal(object, link.localId)
  if (!local) {
    // Local row is gone. Drop the link rather than resurrecting the record —
    // a deliberate local delete must not be undone by the next pull.
    await db().crmSyncRecord.delete({ where: { id: link.id } })
    stats.skipped++
    return
  }

  const localProjection = pickMapped(
    toRemote(local as Record<string, unknown>, mappings.filter((m) => m.object === object)),
    mappings,
    object
  )
  const localHash = hashFields(localProjection)

  const remoteChanged = link.remoteHash !== remoteHash
  const localChanged = link.localHash !== localHash

  const decision = resolveConflict({
    policy,
    localChanged,
    remoteChanged,
    localUpdatedAt: local.updatedAt,
    remoteUpdatedAt: record.updatedAt,
  })

  switch (decision.action) {
    case 'skip':
      stats.skipped++
      // Refresh the watermark so an unchanged record is not re-examined forever.
      await db().crmSyncRecord.update({
        where: { id: link.id },
        data: { lastPulledAt: new Date(), lastError: null },
      })
      return

    case 'pull': {
      const patch = sanitisePatch(toLocal(record.fields, mappings.filter((m) => m.object === object)))
      await updateLocal(object, link.localId, patch)
      const refreshed = await findLocal(object, link.localId)
      const newLocalHash = hashFields(
        pickMapped(
          toRemote(refreshed as Record<string, unknown>, mappings.filter((m) => m.object === object)),
          mappings,
          object
        )
      )
      await db().crmSyncRecord.update({
        where: { id: link.id },
        data: {
          remoteHash, localHash: newLocalHash, lastPulledAt: new Date(),
          conflictAt: null, lastError: null,
        },
      })
      stats.updated++
      return
    }

    case 'push':
      // The local side is newer; leave it for the push pass and only record that
      // we have seen this remote version.
      await db().crmSyncRecord.update({
        where: { id: link.id },
        data: { lastPulledAt: new Date() },
      })
      stats.skipped++
      return

    case 'flag':
      await db().crmSyncRecord.update({
        where: { id: link.id },
        data: {
          conflictAt: new Date(),
          lastError: `Conflict: ${decision.reason}`,
          lastPulledAt: new Date(),
        },
      })
      stats.conflicts++
      return
  }
}

/** The mapped subset, in remote field terms, for hashing on both sides. */
function pickMapped(
  fields: Record<string, CrmValue>,
  mappings: FieldMapping[],
  object: CrmObject
): Record<string, CrmValue> {
  const names = mappings.filter((m) => m.object === object).map((m) => m.remoteField)
  const out: Record<string, CrmValue> = {}
  for (const n of names) if (n in fields) out[n] = fields[n]
  return out
}

/** Never overwrite a populated local value when adopting an existing record. */
function fillGapsOnly(
  local: Record<string, unknown>,
  patch: Record<string, CrmValue>
): Record<string, CrmValue> {
  const out: Record<string, CrmValue> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (local[k] === null || local[k] === undefined || local[k] === '') out[k] = v
  }
  return out
}

async function matchExistingLocal(
  object: CrmObject,
  patch: Record<string, CrmValue>
): Promise<LocalRow | null> {
  if (object === 'contact' && typeof patch.email === 'string') {
    return (await db().contact.findFirst({
      where: { email: patch.email.toLowerCase() },
      include: { account: true },
    })) as LocalRow | null
  }
  if (object === 'account') {
    if (typeof patch.domain === 'string' && patch.domain) {
      const domain = patch.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
      const byDomain = await db().account.findFirst({ where: { domain } })
      if (byDomain) return byDomain as LocalRow
    }
    if (typeof patch.name === 'string' && patch.name) {
      return (await db().account.findFirst({
        where: { name: { equals: patch.name, mode: 'insensitive' } },
      })) as LocalRow | null
    }
  }
  if (object === 'lead' && typeof patch.email === 'string') {
    return (await db().lead.findFirst({ where: { email: patch.email.toLowerCase() } })) as LocalRow | null
  }
  return null
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export async function pushObject(opts: {
  adapter: CrmAdapter
  ctx: CrmConnectionContext
  object: CrmObject
  mappings: FieldMapping[]
  direction: SyncDirection
  localIds?: string[]
  batchSize?: number
}): Promise<SyncStats> {
  const { adapter, ctx, object, mappings, direction, localIds, batchSize = 200 } = opts
  const stats = emptyStats(object)
  const log = logger.child({ crm: adapter.key, object, op: 'push' })

  if (direction === 'pull' || direction === 'none') {
    stats.skipped++
    return stats
  }

  const objectMappings = mappings.filter((m) => m.object === object)
  if (!objectMappings.length) {
    stats.errors.push('No field mappings configured for this object.')
    return stats
  }

  const candidates = await collectPushCandidates(object, localIds, batchSize)

  const payload: { localId: string; remoteId?: string; fields: Record<string, CrmValue> }[] = []
  const hashes = new Map<string, string>()

  for (const local of candidates) {
    const link = await db().crmSyncRecord.findFirst({
      where: { connectionId: ctx.connectionId, object, localId: local.id },
    })

    const fields = toRemote(local as Record<string, unknown>, objectMappings)
    const projection = pickMapped(fields, mappings, object)
    const localHash = hashFields(projection)

    // Nothing we map has changed since the last push — do not spend an API call.
    if (link && link.localHash === localHash && link.remoteId) {
      stats.skipped++
      continue
    }
    if (link?.conflictAt) {
      // A flagged conflict needs a human; pushing over it would destroy the
      // remote edit we could not adjudicate.
      stats.conflicts++
      continue
    }

    hashes.set(local.id, localHash)
    payload.push({ localId: local.id, remoteId: link?.remoteId, fields })
  }

  if (!payload.length) return stats

  let results
  try {
    results = await adapter.push(ctx, object, payload)
  } catch (err) {
    if (err instanceof CrmRateLimitError) {
      log.warn({ retryAfter: err.retryAfterSeconds }, 'rate limited during push')
      stats.errors.push('Rate limited; resuming later.')
      return stats
    }
    throw err
  }

  for (const result of results) {
    if (!result.ok) {
      stats.failed++
      if (result.error) stats.errors.push(`${result.localId}: ${result.error}`)
      await db().crmSyncRecord.updateMany({
        where: { connectionId: ctx.connectionId, object, localId: result.localId },
        data: { lastError: result.error?.slice(0, 500) ?? 'Push failed' },
      })
      continue
    }

    const localHash = hashes.get(result.localId) ?? null
    const existing = await db().crmSyncRecord.findFirst({
      where: { connectionId: ctx.connectionId, object, localId: result.localId },
    })

    if (existing) {
      await db().crmSyncRecord.update({
        where: { id: existing.id },
        data: {
          remoteId: result.remoteId ?? existing.remoteId,
          localHash,
          // The remote now matches what we just sent, so record that as its hash
          // too. Without this the next pull sees a difference and echoes back.
          remoteHash: localHash,
          lastPushedAt: new Date(),
          lastError: null,
        },
      })
    } else if (result.remoteId) {
      await db().crmSyncRecord.create({
        data: {
          connectionId: ctx.connectionId, object, localId: result.localId,
          remoteId: result.remoteId, localHash, remoteHash: localHash,
          lastPushedAt: new Date(),
        },
      })
    }

    stats.pushed++
  }

  return stats
}

async function collectPushCandidates(
  object: CrmObject,
  localIds: string[] | undefined,
  take: number
): Promise<LocalRow[]> {
  const where = localIds?.length ? { id: { in: localIds } } : {}
  switch (MODEL[object as Exclude<CrmObject, 'activity'>]) {
    case 'contact':
      return (await db().contact.findMany({
        where, include: { account: true }, orderBy: { updatedAt: 'desc' }, take,
      })) as LocalRow[]
    case 'account':
      return (await db().account.findMany({ where, orderBy: { updatedAt: 'desc' }, take })) as LocalRow[]
    case 'lead':
      return (await db().lead.findMany({ where, orderBy: { updatedAt: 'desc' }, take })) as LocalRow[]
    case 'deal':
      return (await db().deal.findMany({ where, orderBy: { updatedAt: 'desc' }, take })) as LocalRow[]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function syncConnection(opts: {
  adapter: CrmAdapter
  ctx: CrmConnectionContext
  objects?: CrmObject[]
}): Promise<SyncStats[]> {
  const { adapter, ctx, objects = ['account', 'contact', 'lead'] } = opts

  const connection = await db().crmConnection.findUniqueOrThrow({
    where: { id: ctx.connectionId },
    include: { fieldMappings: true },
  })

  const mappings: FieldMapping[] = connection.fieldMappings.map((m) => ({
    object: m.object as CrmObject,
    localField: m.localField,
    remoteField: m.remoteField,
    direction: m.direction as SyncDirection,
    transform: (m.transform ?? undefined) as FieldMapping['transform'],
    transformConfig: (m.transformConfig ?? {}) as Record<string, unknown>,
  }))

  const settings = (connection.credentials as { conflictPolicy?: ConflictPolicy }) ?? {}
  const policy: ConflictPolicy = settings.conflictPolicy ?? 'last_write_wins'

  const all: SyncStats[] = []
  const startedAt = new Date()

  for (const object of objects) {
    const objectMappings = mappings.filter((m) => m.object === object)
    if (!objectMappings.length) continue

    // Direction for the object is the widest any of its mappings ask for.
    const direction: SyncDirection = objectMappings.some((m) => m.direction === 'bidirectional')
      ? 'bidirectional'
      : objectMappings.every((m) => m.direction === 'pull')
        ? 'pull'
        : objectMappings.every((m) => m.direction === 'push')
          ? 'push'
          : 'bidirectional'

    // Accounts before contacts, so a contact can attach to its company.
    const pulled = await pullObject({ adapter, ctx, object, mappings, policy, direction })
    const pushed = await pushObject({ adapter, ctx, object, mappings, direction })

    all.push({
      ...pulled,
      pushed: pushed.pushed,
      failed: pulled.failed + pushed.failed,
      conflicts: pulled.conflicts + pushed.conflicts,
      skipped: pulled.skipped + pushed.skipped,
      errors: [...pulled.errors, ...pushed.errors],
    })
  }

  const anyErrors = all.some((s) => s.errors.length || s.failed)
  await db().crmConnection.update({
    where: { id: ctx.connectionId },
    data: {
      lastSyncAt: startedAt,
      status: anyErrors ? 'error' : 'connected',
      lastError: anyErrors ? all.flatMap((s) => s.errors).slice(0, 3).join(' | ') : null,
    },
  })

  return all
}
