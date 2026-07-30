import type {
  CrmAdapter, CrmConnectionContext, CrmObject, CrmObjectSchema, CrmPage,
  CrmRecord, CrmValue, CrmWriteResult, CrmTokens, CrmActivity,
} from './types'

/**
 * An in-memory CRM.
 *
 * This exists so the sync engine can be tested against real behaviour — echo
 * loops, conflicts, partial failures, pagination — without a Salesforce org.
 * Mocking the adapter method-by-method would test that the mocks were called;
 * this tests that data actually converges.
 *
 * It is shipped in `src/` rather than in the test folder because it is also the
 * reference implementation for anyone writing the next adapter.
 */

type Row = {
  remoteId: string
  fields: Record<string, CrmValue>
  updatedAt: Date
  deleted?: boolean
}

export class FakeCrm implements CrmAdapter {
  readonly key = 'hubspot' as const // any non-salesforce key; the engine is agnostic
  readonly label = 'Fake CRM'

  private store = new Map<CrmObject, Map<string, Row>>()
  private seq = 0
  private clock = new Date('2026-07-01T00:00:00Z')

  /** Set by tests to make the next call fail, so failure paths are exercised. */
  failNextPush: { localId: string; error: string; permanent?: boolean } | null = null
  failNextPull: Error | null = null
  pageSize = 100

  readonly calls = { pull: 0, push: 0, describe: 0 }

  // --- test helpers --------------------------------------------------------

  advanceClock(ms: number) {
    this.clock = new Date(this.clock.getTime() + ms)
  }

  now(): Date {
    return new Date(this.clock.getTime())
  }

  /** Simulates a human editing the record inside the CRM. */
  remoteEdit(object: CrmObject, remoteId: string, patch: Record<string, CrmValue>) {
    const table = this.table(object)
    const row = table.get(remoteId)
    if (!row) throw new Error(`No such remote record: ${remoteId}`)
    this.advanceClock(1000)
    table.set(remoteId, { ...row, fields: { ...row.fields, ...patch }, updatedAt: this.now() })
  }

  seedRemote(object: CrmObject, fields: Record<string, CrmValue>): string {
    const remoteId = `remote_${++this.seq}`
    this.advanceClock(1000)
    this.table(object).set(remoteId, { remoteId, fields, updatedAt: this.now() })
    return remoteId
  }

  softDelete(object: CrmObject, remoteId: string) {
    const row = this.table(object).get(remoteId)
    if (row) {
      this.advanceClock(1000)
      this.table(object).set(remoteId, { ...row, deleted: true, updatedAt: this.now() })
    }
  }

  read(object: CrmObject, remoteId: string): Record<string, CrmValue> | undefined {
    return this.table(object).get(remoteId)?.fields
  }

  count(object: CrmObject): number {
    return [...this.table(object).values()].filter((r) => !r.deleted).length
  }

  private table(object: CrmObject): Map<string, Row> {
    let t = this.store.get(object)
    if (!t) {
      t = new Map()
      this.store.set(object, t)
    }
    return t
  }

  // --- adapter -------------------------------------------------------------

  authorizeUrl() {
    return 'https://fake.crm/authorize'
  }

  async exchange(): Promise<CrmTokens> {
    return { accessToken: 'fake-access', refreshToken: 'fake-refresh', instanceUrl: 'https://fake.crm' }
  }

  async refresh(): Promise<CrmTokens> {
    return { accessToken: 'fake-access-2', refreshToken: 'fake-refresh', instanceUrl: 'https://fake.crm' }
  }

  async describe(_ctx: CrmConnectionContext, object: CrmObject): Promise<CrmObjectSchema> {
    this.calls.describe++
    return {
      object,
      remoteName: object,
      fields: [
        { name: 'Email', label: 'Email', type: 'string', required: false, updateable: true },
        { name: 'FirstName', label: 'First name', type: 'string', required: false, updateable: true },
        { name: 'LastName', label: 'Last name', type: 'string', required: true, updateable: true },
        { name: 'Title', label: 'Title', type: 'string', required: false, updateable: true, maxLength: 20 },
        { name: 'Name', label: 'Name', type: 'string', required: true, updateable: true },
        { name: 'Website', label: 'Website', type: 'string', required: false, updateable: true },
        { name: 'Industry', label: 'Industry', type: 'picklist', required: false, updateable: true, picklistValues: ['Logistics', 'Software', 'Retail'] },
        { name: 'NumberOfEmployees', label: 'Employees', type: 'number', required: false, updateable: true },
        { name: 'ReadOnlyField', label: 'Read only', type: 'string', required: false, updateable: false },
      ],
    }
  }

  async pull(
    _ctx: CrmConnectionContext,
    object: CrmObject,
    since: Date | null,
    cursor?: string
  ): Promise<CrmPage<CrmRecord>> {
    this.calls.pull++

    if (this.failNextPull) {
      const err = this.failNextPull
      this.failNextPull = null
      throw err
    }

    const all = [...this.table(object).values()]
      .filter((r) => !since || r.updatedAt >= since)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())

    const offset = cursor ? Number(cursor) : 0
    const slice = all.slice(offset, offset + this.pageSize)
    const nextOffset = offset + slice.length

    return {
      records: slice.map((r) => ({
        remoteId: r.remoteId,
        fields: { ...r.fields },
        updatedAt: r.updatedAt,
        deleted: r.deleted,
      })),
      cursor: nextOffset < all.length ? String(nextOffset) : undefined,
      watermark: slice.length ? slice[slice.length - 1].updatedAt : undefined,
    }
  }

  async push(
    _ctx: CrmConnectionContext,
    object: CrmObject,
    records: { localId: string; remoteId?: string; fields: Record<string, CrmValue> }[]
  ): Promise<CrmWriteResult[]> {
    this.calls.push++
    const table = this.table(object)
    const results: CrmWriteResult[] = []

    for (const r of records) {
      if (this.failNextPush && this.failNextPush.localId === r.localId) {
        const f = this.failNextPush
        this.failNextPush = null
        results.push({ localId: r.localId, remoteId: r.remoteId, ok: false, error: f.error, permanent: f.permanent })
        continue
      }

      this.advanceClock(1000)

      if (r.remoteId && table.has(r.remoteId)) {
        const existing = table.get(r.remoteId)!
        table.set(r.remoteId, {
          ...existing,
          fields: { ...existing.fields, ...r.fields },
          updatedAt: this.now(),
        })
        results.push({ localId: r.localId, remoteId: r.remoteId, ok: true })
      } else {
        const remoteId = `remote_${++this.seq}`
        table.set(remoteId, { remoteId, fields: { ...r.fields }, updatedAt: this.now() })
        results.push({ localId: r.localId, remoteId, ok: true })
      }
    }

    return results
  }

  async logActivity(_ctx: CrmConnectionContext, activity: CrmActivity): Promise<CrmWriteResult> {
    return { localId: activity.remoteRecordId, remoteId: `activity_${++this.seq}`, ok: true }
  }
}
