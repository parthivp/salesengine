import type { CrmObject, CrmValue, CrmFieldDescriptor } from './types'
import { createHash } from 'node:crypto'

/**
 * Field mapping and conflict resolution.
 *
 * Pure functions. These are the rules that decide whose data wins, and getting
 * them wrong silently corrupts a customer's CRM — the one thing they will not
 * forgive. So they are separated from all I/O and tested directly.
 */

export type SyncDirection = 'push' | 'pull' | 'bidirectional' | 'none'

export type TransformKind =
  | 'identity'
  | 'uppercase'
  | 'lowercase'
  | 'trim'
  | 'date_iso'
  | 'number'
  | 'boolean'
  | 'picklist_map'
  | 'truncate'
  | 'join_name'

export type FieldMapping = {
  object: CrmObject
  localField: string
  remoteField: string
  direction: SyncDirection
  transform?: TransformKind
  transformConfig?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export function applyTransform(
  value: unknown,
  transform: TransformKind | undefined,
  config: Record<string, unknown> = {}
): CrmValue {
  if (value === null || value === undefined) return null

  switch (transform) {
    case undefined:
    case 'identity':
      return coerce(value)

    case 'uppercase':
      return String(value).toUpperCase()

    case 'lowercase':
      return String(value).toLowerCase()

    case 'trim':
      return String(value).trim()

    case 'date_iso': {
      const d = value instanceof Date ? value : new Date(String(value))
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }

    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      const cleaned = String(value).replace(/[^0-9.eE+-]/g, '')
      // Stripping non-numerics can leave an empty string, and Number('') is 0.
      // Returning 0 for "not a number" would write a plausible-looking wrong
      // value into the CRM, which is worse than writing nothing.
      if (!/[0-9]/.test(cleaned)) return null
      const n = Number(cleaned)
      return Number.isFinite(n) ? n : null
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value
      const s = String(value).trim().toLowerCase()
      return ['true', '1', 'yes', 'y', 'on'].includes(s)
    }

    case 'picklist_map': {
      const map = (config.map ?? {}) as Record<string, string>
      const key = String(value)
      // An unmapped picklist value must not be written blindly: Salesforce
      // rejects values outside the picklist, failing the whole record.
      if (key in map) return map[key]
      const fallback = config.fallback
      return typeof fallback === 'string' ? fallback : null
    }

    case 'truncate': {
      const max = typeof config.maxLength === 'number' ? config.maxLength : 255
      const s = String(value)
      return s.length > max ? s.slice(0, max) : s
    }

    case 'join_name': {
      // Local first/last -> a single remote Name field.
      const parts = Array.isArray(value) ? value : [value]
      return parts.filter(Boolean).map(String).join(' ').trim() || null
    }

    default:
      return coerce(value)
  }
}

function coerce(value: unknown): CrmValue {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return value as CrmValue
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Reads a possibly dotted path, so `account.name` can map to a remote field. */
export function readPath(source: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return source[path]
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, source)
}

/**
 * Local record -> remote payload. Skips pull-only mappings and drops keys whose
 * value is undefined, so a partial local record does not blank remote fields.
 */
export function toRemote(
  local: Record<string, unknown>,
  mappings: FieldMapping[],
  schema?: CrmFieldDescriptor[]
): Record<string, CrmValue> {
  const out: Record<string, CrmValue> = {}
  const byName = new Map(schema?.map((f) => [f.name, f]) ?? [])

  for (const m of mappings) {
    if (m.direction === 'pull' || m.direction === 'none') continue

    const raw = readPath(local, m.localField)
    if (raw === undefined) continue

    let value = applyTransform(raw, m.transform, m.transformConfig)

    const descriptor = byName.get(m.remoteField)
    if (descriptor) {
      // Respect the provider's own constraints rather than letting it reject the
      // whole record: a 300-character title should be truncated, not fatal.
      if (descriptor.updateable === false) continue
      if (descriptor.maxLength && typeof value === 'string' && value.length > descriptor.maxLength) {
        value = value.slice(0, descriptor.maxLength)
      }
      if (
        descriptor.type === 'picklist' &&
        descriptor.picklistValues?.length &&
        typeof value === 'string' &&
        !descriptor.picklistValues.includes(value)
      ) {
        continue // unknown picklist value: omit rather than fail the record
      }
    }

    out[m.remoteField] = value
  }

  return out
}

/** Remote payload -> local patch. Skips push-only mappings. */
export function toLocal(
  remote: Record<string, CrmValue>,
  mappings: FieldMapping[]
): Record<string, CrmValue> {
  const out: Record<string, CrmValue> = {}
  for (const m of mappings) {
    if (m.direction === 'push' || m.direction === 'none') continue
    if (!(m.remoteField in remote)) continue
    // Dotted local paths are read-only projections; writing through them would
    // need to know how to create the related record, which is a separate concern.
    if (m.localField.includes('.')) continue
    out[m.localField] = applyTransform(remote[m.remoteField], m.transform, m.transformConfig)
  }
  return out
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Stable hash of the mapped projection.
 *
 * Hashing the *mapped* fields rather than the whole record is what stops the
 * sync loop: a change to a field nobody maps must not look like a change, or two
 * bidirectional systems will echo edits back and forth forever.
 */
export function hashFields(fields: Record<string, CrmValue>): string {
  // Empty values are omitted rather than stringified, so "field absent" and
  // "field present but null/empty" hash identically.
  //
  // This is load-bearing. A record pulled from a CRM that has no Title arrives
  // with Title absent, but the local row stores title as null — so projecting
  // that row back produces `Title: null`. Hashing those differently makes the
  // record look changed the instant it lands, and the engine pushes it straight
  // back to the CRM. That is the echo loop, one field at a time.
  const normalised = Object.keys(fields)
    .filter((k) => {
      const v = fields[k]
      return v !== null && v !== undefined && v !== ''
    })
    .sort()
    .map((k) => `${k}=${String(fields[k])}`)
    .join(' ')
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export type ConflictPolicy = 'last_write_wins' | 'crm_wins' | 'app_wins' | 'manual'

export type ConflictInput = {
  policy: ConflictPolicy
  localChanged: boolean
  remoteChanged: boolean
  localUpdatedAt?: Date | null
  remoteUpdatedAt?: Date | null
}

export type ConflictDecision =
  | { action: 'push' }
  | { action: 'pull' }
  | { action: 'skip'; reason: string }
  | { action: 'flag'; reason: string }

/**
 * Decides what to do when both sides may have moved.
 *
 * The interesting case is both-changed. `last_write_wins` needs both timestamps;
 * if either is missing it flags rather than guessing, because guessing here means
 * silently discarding somebody's edit.
 */
export function resolveConflict(input: ConflictInput): ConflictDecision {
  const { policy, localChanged, remoteChanged, localUpdatedAt, remoteUpdatedAt } = input

  if (!localChanged && !remoteChanged) return { action: 'skip', reason: 'no_change' }
  if (localChanged && !remoteChanged) return { action: 'push' }
  if (!localChanged && remoteChanged) return { action: 'pull' }

  // Both sides changed since the last sync.
  switch (policy) {
    case 'crm_wins':
      return { action: 'pull' }
    case 'app_wins':
      return { action: 'push' }
    case 'manual':
      return { action: 'flag', reason: 'both_changed_manual_policy' }
    case 'last_write_wins': {
      if (!localUpdatedAt || !remoteUpdatedAt) {
        return { action: 'flag', reason: 'both_changed_missing_timestamps' }
      }
      if (remoteUpdatedAt.getTime() === localUpdatedAt.getTime()) {
        return { action: 'flag', reason: 'both_changed_identical_timestamps' }
      }
      return remoteUpdatedAt > localUpdatedAt ? { action: 'pull' } : { action: 'push' }
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Sensible Salesforce mappings, offered as a starting point in the UI. */
export const SALESFORCE_DEFAULTS: FieldMapping[] = [
  { object: 'contact', localField: 'firstName', remoteField: 'FirstName', direction: 'bidirectional' },
  { object: 'contact', localField: 'lastName', remoteField: 'LastName', direction: 'bidirectional' },
  { object: 'contact', localField: 'email', remoteField: 'Email', direction: 'bidirectional', transform: 'lowercase' },
  { object: 'contact', localField: 'title', remoteField: 'Title', direction: 'bidirectional', transform: 'truncate', transformConfig: { maxLength: 128 } },
  { object: 'contact', localField: 'phone', remoteField: 'Phone', direction: 'bidirectional' },
  { object: 'contact', localField: 'city', remoteField: 'MailingCity', direction: 'bidirectional' },
  { object: 'contact', localField: 'country', remoteField: 'MailingCountry', direction: 'bidirectional' },

  { object: 'account', localField: 'name', remoteField: 'Name', direction: 'bidirectional' },
  { object: 'account', localField: 'domain', remoteField: 'Website', direction: 'bidirectional', transform: 'lowercase' },
  { object: 'account', localField: 'industry', remoteField: 'Industry', direction: 'bidirectional' },
  { object: 'account', localField: 'employeeCount', remoteField: 'NumberOfEmployees', direction: 'bidirectional', transform: 'number' },
  { object: 'account', localField: 'country', remoteField: 'BillingCountry', direction: 'bidirectional' },

  { object: 'lead', localField: 'firstName', remoteField: 'FirstName', direction: 'push' },
  { object: 'lead', localField: 'lastName', remoteField: 'LastName', direction: 'push' },
  { object: 'lead', localField: 'email', remoteField: 'Email', direction: 'push', transform: 'lowercase' },
  { object: 'lead', localField: 'company', remoteField: 'Company', direction: 'push' },
  { object: 'lead', localField: 'title', remoteField: 'Title', direction: 'push' },
]

/**
 * Salesforce requires LastName and Company on Lead, and LastName on Contact.
 * Catching that here means a clear message in the mapping UI instead of a wall
 * of REQUIRED_FIELD_MISSING errors on the first sync.
 */
export function validateMappings(
  object: CrmObject,
  mappings: FieldMapping[],
  schema?: CrmFieldDescriptor[]
): string[] {
  const problems: string[] = []
  const mapped = new Set(mappings.filter((m) => m.object === object).map((m) => m.remoteField))

  for (const field of schema ?? []) {
    if (field.required && field.updateable && !mapped.has(field.name)) {
      problems.push(`${field.label} (${field.name}) is required by the CRM but is not mapped.`)
    }
  }

  const seen = new Map<string, string>()
  for (const m of mappings.filter((x) => x.object === object)) {
    if (m.direction === 'pull' || m.direction === 'none') continue
    const prior = seen.get(m.remoteField)
    if (prior && prior !== m.localField) {
      problems.push(
        `${m.remoteField} is written from both ${prior} and ${m.localField}; the last one would win unpredictably.`
      )
    }
    seen.set(m.remoteField, m.localField)
  }

  return problems
}
