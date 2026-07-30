/**
 * The CRM connector contract.
 *
 * Everything expensive — the sync engine, field mapping, conflict resolution,
 * watermarks, retry — lives *above* this interface. An adapter is only transport
 * plus schema translation, which is why the second adapter costs a fraction of
 * the first.
 *
 * The interface is deliberately narrow. Anything a specific CRM can do that
 * others cannot (Salesforce Platform Events, HubSpot associations) is exposed as
 * an optional method, so the engine can use it when present and fall back when
 * not, rather than every adapter having to fake it.
 */

export type CrmObject = 'account' | 'contact' | 'lead' | 'deal' | 'activity'

export type CrmValue = string | number | boolean | null | undefined

/** A record as the CRM sees it: remote id plus a flat field bag. */
export type CrmRecord = {
  remoteId: string
  fields: Record<string, CrmValue>
  /** Provider's own modification timestamp — the basis for conflict detection. */
  updatedAt?: Date
  deleted?: boolean
}

export type CrmPage<T> = {
  records: T[]
  /** Opaque; pass back to continue. Absent means the last page. */
  cursor?: string
  /** Highest `updatedAt` seen, for the next incremental pull. */
  watermark?: Date
}

export type CrmWriteResult = {
  localId: string
  remoteId?: string
  ok: boolean
  error?: string
  /** True when the provider rejected the payload permanently; do not retry. */
  permanent?: boolean
}

export type CrmFieldDescriptor = {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'picklist' | 'reference' | 'other'
  required: boolean
  updateable: boolean
  picklistValues?: string[]
  /** Length limit where the provider enforces one; used to truncate rather than fail. */
  maxLength?: number
}

export type CrmObjectSchema = {
  object: CrmObject
  remoteName: string
  fields: CrmFieldDescriptor[]
}

export type CrmConnectionContext = {
  connectionId: string
  tenantId: string
  instanceUrl?: string
  /** Decrypted at the edge of the sync engine; never persisted in the clear. */
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
}

export type OAuthGrant = {
  code?: string
  refreshToken?: string
  redirectUri?: string
}

export type CrmTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  instanceUrl?: string
  externalId?: string
}

export type CrmActivity = {
  remoteRecordId: string
  object: CrmObject
  type: 'email' | 'call' | 'task' | 'note'
  subject: string
  body?: string
  occurredAt: Date
  ownerRemoteId?: string
}

export interface CrmAdapter {
  readonly key: 'salesforce' | 'hubspot' | 'pipedrive' | 'zoho'
  readonly label: string

  /** OAuth authorise URL for the connect flow. */
  authorizeUrl(opts: { redirectUri: string; state: string }): string

  /** Exchange a code, or refresh an expired access token. */
  exchange(grant: OAuthGrant): Promise<CrmTokens>
  refresh(refreshToken: string): Promise<CrmTokens>

  /** What fields exist, so the mapping UI is driven by the real schema. */
  describe(ctx: CrmConnectionContext, object: CrmObject): Promise<CrmObjectSchema>

  /** Incremental read. `since` is the previous watermark. */
  pull(
    ctx: CrmConnectionContext,
    object: CrmObject,
    since: Date | null,
    cursor?: string
  ): Promise<CrmPage<CrmRecord>>

  /** Upsert. Records with no remoteId are creates. */
  push(
    ctx: CrmConnectionContext,
    object: CrmObject,
    records: { localId: string; remoteId?: string; fields: Record<string, CrmValue> }[]
  ): Promise<CrmWriteResult[]>

  logActivity(ctx: CrmConnectionContext, activity: CrmActivity): Promise<CrmWriteResult>

  /** Optional: near-real-time change capture where the provider supports it. */
  supportsChangeEvents?: boolean
}

/** Raised when the access token is dead and a refresh is required. */
export class CrmAuthError extends Error {
  constructor(message = 'CRM authorisation failed') {
    super(message)
    this.name = 'CrmAuthError'
  }
}

/** Raised when the provider is rate limiting; the engine backs off rather than failing. */
export class CrmRateLimitError extends Error {
  constructor(
    message = 'CRM rate limit reached',
    readonly retryAfterSeconds = 60
  ) {
    super(message)
    this.name = 'CrmRateLimitError'
  }
}
