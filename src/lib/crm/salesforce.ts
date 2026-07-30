import { env } from '../env'
import { logger } from '../logger'
import {
  CrmAuthError, CrmRateLimitError,
  type CrmAdapter, type CrmConnectionContext, type CrmObject, type CrmObjectSchema,
  type CrmPage, type CrmRecord, type CrmValue, type CrmWriteResult, type CrmTokens,
  type OAuthGrant, type CrmActivity, type CrmFieldDescriptor,
} from './types'

/**
 * Salesforce adapter.
 *
 * Built first on purpose: it is the most awkward of the major CRMs, so the
 * connector interface gets stress-tested by the hardest case rather than the
 * easiest. HubSpot afterwards is mostly a matter of different field names.
 *
 * Notes that cost time if you do not know them:
 *  - Website is a URL field, not a domain; a bare domain is accepted but comes
 *    back normalised, which looks like a remote change unless handled.
 *  - Lead requires LastName and Company. Contact requires LastName.
 *  - SOQL has no OFFSET beyond 2000 rows; pagination is via nextRecordsUrl.
 *  - composite/sobjects handles 200 records per call and reports per-record errors.
 *  - Deleted rows only appear via queryAll or the deleted endpoint.
 */

const API_VERSION = 'v62.0'
const LOGIN_HOST = 'https://login.salesforce.com'

const OBJECT_NAME: Record<CrmObject, string> = {
  account: 'Account',
  contact: 'Contact',
  lead: 'Lead',
  deal: 'Opportunity',
  activity: 'Task',
}

function required(): { clientId: string; clientSecret: string } {
  if (!env.SALESFORCE_CLIENT_ID || !env.SALESFORCE_CLIENT_SECRET) {
    throw new CrmAuthError(
      'Salesforce is not configured. Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET.'
    )
  }
  return { clientId: env.SALESFORCE_CLIENT_ID, clientSecret: env.SALESFORCE_CLIENT_SECRET }
}

type SfError = { message?: string; errorCode?: string; statusCode?: string; fields?: string[] }

async function call<T>(
  ctx: CrmConnectionContext,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!ctx.instanceUrl) throw new CrmAuthError('Salesforce connection has no instance URL.')

  const url = path.startsWith('http') ? path : `${ctx.instanceUrl}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  if (res.status === 401) {
    // The engine catches this, refreshes, and retries once.
    throw new CrmAuthError('Salesforce access token expired or revoked.')
  }

  if (res.status === 403) {
    const text = await res.text().catch(() => '')
    if (text.includes('REQUEST_LIMIT_EXCEEDED')) {
      throw new CrmRateLimitError('Salesforce daily API limit reached.', 3600)
    }
    throw new Error(`Salesforce 403: ${text.slice(0, 300)}`)
  }

  if (res.status === 429 || res.status === 503) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60
    throw new CrmRateLimitError('Salesforce is throttling requests.', retryAfter)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Salesforce ${res.status} on ${path}: ${text.slice(0, 400)}`)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------

const FIELD_TYPE: Record<string, CrmFieldDescriptor['type']> = {
  string: 'string', textarea: 'string', email: 'string', phone: 'string',
  url: 'string', id: 'string', encryptedstring: 'string',
  int: 'number', double: 'number', currency: 'number', percent: 'number',
  boolean: 'boolean', date: 'date', datetime: 'datetime',
  picklist: 'picklist', multipicklist: 'picklist',
  reference: 'reference',
}

export const salesforceAdapter: CrmAdapter = {
  key: 'salesforce',
  label: 'Salesforce',
  supportsChangeEvents: true,

  authorizeUrl({ redirectUri, state }) {
    const { clientId } = required()
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      // refresh_token is what lets sync continue without a human re-authorising.
      scope: 'api refresh_token offline_access',
    })
    return `${LOGIN_HOST}/services/oauth2/authorize?${params}`
  },

  async exchange(grant: OAuthGrant): Promise<CrmTokens> {
    const { clientId, clientSecret } = required()
    if (!grant.code) throw new CrmAuthError('Missing authorisation code.')

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: grant.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: grant.redirectUri ?? '',
    })

    const res = await fetch(`${LOGIN_HOST}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      throw new CrmAuthError(`Token exchange failed: ${(await res.text()).slice(0, 300)}`)
    }

    const json = (await res.json()) as {
      access_token: string
      refresh_token?: string
      instance_url: string
      id: string
      issued_at?: string
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      instanceUrl: json.instance_url,
      // The org id is the middle segment of the identity URL.
      externalId: json.id.split('/').slice(-2, -1)[0],
      // Salesforce does not return expires_in; assume a conservative 2 hours and
      // rely on the 401-then-refresh path as the real mechanism.
      expiresAt: new Date(Date.now() + 2 * 3600_000),
    }
  },

  async refresh(refreshToken: string): Promise<CrmTokens> {
    const { clientId, clientSecret } = required()
    const res = await fetch(`${LOGIN_HOST}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
    if (!res.ok) {
      throw new CrmAuthError(`Token refresh failed: ${(await res.text()).slice(0, 300)}`)
    }
    const json = (await res.json()) as { access_token: string; instance_url?: string }
    return {
      accessToken: json.access_token,
      refreshToken,
      instanceUrl: json.instance_url,
      expiresAt: new Date(Date.now() + 2 * 3600_000),
    }
  },

  async describe(ctx, object): Promise<CrmObjectSchema> {
    const remoteName = OBJECT_NAME[object]
    const json = await call<{
      fields: {
        name: string
        label: string
        type: string
        nillable: boolean
        createable: boolean
        updateable: boolean
        length?: number
        picklistValues?: { value: string; active: boolean }[]
      }[]
    }>(ctx, `/services/data/${API_VERSION}/sobjects/${remoteName}/describe`)

    return {
      object,
      remoteName,
      fields: json.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: FIELD_TYPE[f.type] ?? 'other',
        // Salesforce's own definition: not nillable and creatable means required.
        required: !f.nillable && f.createable,
        updateable: f.updateable,
        maxLength: f.length && f.length > 0 ? f.length : undefined,
        picklistValues: f.picklistValues?.filter((p) => p.active).map((p) => p.value),
      })),
    }
  },

  async pull(ctx, object, since, cursor): Promise<CrmPage<CrmRecord>> {
    const remoteName = OBJECT_NAME[object]

    // A cursor is a full nextRecordsUrl; follow it verbatim.
    if (cursor) {
      const json = await call<SfQueryResponse>(ctx, cursor)
      return toPage(json)
    }

    const fields = await fieldNamesFor(ctx, object)
    const where = since
      ? ` WHERE LastModifiedDate >= ${since.toISOString()}`
      : ''
    const soql =
      `SELECT Id, LastModifiedDate, ${fields.join(', ')} FROM ${remoteName}${where} ` +
      `ORDER BY LastModifiedDate ASC LIMIT 2000`

    const json = await call<SfQueryResponse>(
      ctx,
      `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`
    )
    return toPage(json)
  },

  async push(ctx, object, records): Promise<CrmWriteResult[]> {
    const remoteName = OBJECT_NAME[object]
    const results: CrmWriteResult[] = []

    // composite/sobjects caps at 200 per request.
    for (let i = 0; i < records.length; i += 200) {
      const chunk = records.slice(i, i + 200)
      const updates = chunk.filter((r) => r.remoteId)
      const creates = chunk.filter((r) => !r.remoteId)

      if (updates.length) {
        const json = await call<SfCompositeResult[]>(
          ctx,
          `/services/data/${API_VERSION}/composite/sobjects`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              allOrNone: false, // one bad record must not fail the batch
              records: updates.map((r) => ({
                attributes: { type: remoteName },
                Id: r.remoteId,
                ...stripNulls(r.fields),
              })),
            }),
          }
        )
        json.forEach((res, idx) => results.push(interpret(res, updates[idx].localId, updates[idx].remoteId)))
      }

      if (creates.length) {
        const json = await call<SfCompositeResult[]>(
          ctx,
          `/services/data/${API_VERSION}/composite/sobjects`,
          {
            method: 'POST',
            body: JSON.stringify({
              allOrNone: false,
              records: creates.map((r) => ({
                attributes: { type: remoteName },
                ...stripNulls(r.fields),
              })),
            }),
          }
        )
        json.forEach((res, idx) => results.push(interpret(res, creates[idx].localId)))
      }
    }

    return results
  },

  async logActivity(ctx, activity: CrmActivity): Promise<CrmWriteResult> {
    // Task is the closest native equivalent for logged email and call activity.
    const payload: Record<string, CrmValue> = {
      Subject: activity.subject.slice(0, 255),
      Description: activity.body?.slice(0, 32000),
      Status: 'Completed',
      ActivityDate: activity.occurredAt.toISOString().slice(0, 10),
      TaskSubtype: activity.type === 'email' ? 'Email' : activity.type === 'call' ? 'Call' : 'Task',
      ...(activity.object === 'contact' || activity.object === 'lead'
        ? { WhoId: activity.remoteRecordId }
        : { WhatId: activity.remoteRecordId }),
    }

    try {
      const json = await call<{ id: string; success: boolean; errors: SfError[] }>(
        ctx,
        `/services/data/${API_VERSION}/sobjects/Task`,
        { method: 'POST', body: JSON.stringify(stripNulls(payload)) }
      )
      return { localId: activity.remoteRecordId, remoteId: json.id, ok: json.success }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ err }, 'Salesforce activity log failed')
      return { localId: activity.remoteRecordId, ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------

type SfQueryResponse = {
  totalSize: number
  done: boolean
  nextRecordsUrl?: string
  records: (Record<string, unknown> & { Id: string; LastModifiedDate?: string })[]
}

type SfCompositeResult = { id?: string; success: boolean; errors?: SfError[] }

function toPage(json: SfQueryResponse): CrmPage<CrmRecord> {
  let watermark: Date | undefined
  const records: CrmRecord[] = json.records.map((r) => {
    const { Id, LastModifiedDate, attributes, ...rest } = r as Record<string, unknown> & {
      Id: string
      LastModifiedDate?: string
      attributes?: unknown
    }
    const updatedAt = LastModifiedDate ? new Date(LastModifiedDate) : undefined
    if (updatedAt && (!watermark || updatedAt > watermark)) watermark = updatedAt
    return {
      remoteId: Id,
      updatedAt,
      fields: flatten(rest),
    }
  })

  return { records, cursor: json.done ? undefined : json.nextRecordsUrl, watermark }
}

/** Salesforce nests related objects; flatten one level to `Account.Name` style keys. */
function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, CrmValue> {
  const out: Record<string, CrmValue> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'attributes') continue
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key))
    } else {
      out[key] = v as CrmValue
    }
  }
  return out
}

/**
 * Omits nulls on create/update.
 *
 * Sending null is a deliberate blank, and a partially-populated local record
 * would otherwise wipe fields a human filled in on the Salesforce side.
 */
function stripNulls(fields: Record<string, CrmValue>): Record<string, CrmValue> {
  const out: Record<string, CrmValue> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue
    out[k] = v
  }
  return out
}

/** Validation errors are permanent; anything else may be worth a retry. */
const PERMANENT_CODES = new Set([
  'REQUIRED_FIELD_MISSING', 'INVALID_EMAIL_ADDRESS', 'STRING_TOO_LONG',
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', 'FIELD_INTEGRITY_EXCEPTION',
  'DUPLICATE_VALUE', 'INVALID_FIELD_FOR_INSERT_UPDATE', 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
])

function interpret(res: SfCompositeResult, localId: string, remoteId?: string): CrmWriteResult {
  if (res.success) return { localId, remoteId: res.id ?? remoteId, ok: true }
  const first = res.errors?.[0]
  const code = first?.statusCode ?? first?.errorCode ?? ''
  return {
    localId,
    remoteId,
    ok: false,
    error: `${code}: ${first?.message ?? 'unknown error'}${
      first?.fields?.length ? ` (${first.fields.join(', ')})` : ''
    }`,
    permanent: PERMANENT_CODES.has(code),
  }
}

/** Cached per object so a sync does not re-describe on every page. */
const fieldCache = new Map<string, { names: string[]; at: number }>()
const FIELD_TTL_MS = 15 * 60_000

async function fieldNamesFor(ctx: CrmConnectionContext, object: CrmObject): Promise<string[]> {
  const key = `${ctx.connectionId}:${object}`
  const cached = fieldCache.get(key)
  if (cached && Date.now() - cached.at < FIELD_TTL_MS) return cached.names

  const schema = await salesforceAdapter.describe(ctx, object)
  const names = schema.fields
    .filter((f) => f.name !== 'Id' && f.name !== 'LastModifiedDate')
    // Compound and unqueryable field types are excluded to keep SOQL valid.
    .filter((f) => f.type !== 'other')
    .map((f) => f.name)
    .slice(0, 100) // SOQL has practical length limits

  fieldCache.set(key, { names, at: Date.now() })
  return names
}
