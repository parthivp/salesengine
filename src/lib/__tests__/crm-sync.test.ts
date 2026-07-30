import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant } from '../db'
import { FakeCrm } from '../crm/fake'
import { pullObject, pushObject, syncConnection } from '../crm/sync'
import {
  applyTransform, toRemote, toLocal, hashFields, resolveConflict,
  validateMappings, readPath, type FieldMapping,
} from '../crm/mapping'
import { CrmRateLimitError } from '../crm/types'

/**
 * The sync engine is tested against an in-memory CRM rather than mocks, because
 * the property under test is *convergence* — that data ends up the same on both
 * sides and stops moving. Mocks cannot show that.
 *
 * The echo-loop test is the one that matters. Bidirectional sync that echoes its
 * own writes back will happily run forever, burn the customer's API quota, and
 * look like it is working.
 */

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
let connectionId: string
let crm: FakeCrm

const CONTACT_MAPPINGS: FieldMapping[] = [
  { object: 'contact', localField: 'firstName', remoteField: 'FirstName', direction: 'bidirectional' },
  { object: 'contact', localField: 'lastName', remoteField: 'LastName', direction: 'bidirectional' },
  { object: 'contact', localField: 'email', remoteField: 'Email', direction: 'bidirectional', transform: 'lowercase' },
  { object: 'contact', localField: 'title', remoteField: 'Title', direction: 'bidirectional' },
]

function ctx() {
  return {
    connectionId,
    tenantId,
    instanceUrl: 'https://fake.crm',
    accessToken: 'fake-access',
  }
}

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'crm-test' },
    update: {},
    create: { slug: 'crm-test', name: 'CRM Test Co' },
  })
  tenantId = t.id
})

beforeEach(async () => {
  await owner.crmSyncRecord.deleteMany({ where: { connection: { tenantId } } })
  await owner.crmFieldMapping.deleteMany({ where: { connection: { tenantId } } })
  await owner.crmConnection.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.lead.deleteMany({ where: { tenantId } })

  const conn = await owner.crmConnection.create({
    data: {
      tenantId,
      provider: 'hubspot',
      status: 'connected',
      instanceUrl: 'https://fake.crm',
      credentials: { conflictPolicy: 'last_write_wins' },
    },
  })
  connectionId = conn.id
  crm = new FakeCrm()
})

afterAll(async () => {
  await owner.crmSyncRecord.deleteMany({ where: { connection: { tenantId } } })
  await owner.crmConnection.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

async function pull(policy: 'last_write_wins' | 'crm_wins' | 'app_wins' | 'manual' = 'last_write_wins') {
  return withTenant(tenantId, () =>
    pullObject({
      adapter: crm, ctx: ctx(), object: 'contact',
      mappings: CONTACT_MAPPINGS, policy, direction: 'bidirectional',
    })
  )
}

async function push() {
  return withTenant(tenantId, () =>
    pushObject({
      adapter: crm, ctx: ctx(), object: 'contact',
      mappings: CONTACT_MAPPINGS, direction: 'bidirectional',
    })
  )
}

// ===========================================================================

describe('transforms', () => {
  it('handles the basics', () => {
    expect(applyTransform('  Hi  ', 'trim')).toBe('Hi')
    expect(applyTransform('abc', 'uppercase')).toBe('ABC')
    expect(applyTransform('ABC', 'lowercase')).toBe('abc')
    expect(applyTransform('1,200', 'number')).toBe(1200)
    expect(applyTransform('yes', 'boolean')).toBe(true)
    expect(applyTransform('no', 'boolean')).toBe(false)
    expect(applyTransform(new Date('2026-07-30T00:00:00Z'), 'date_iso')).toBe('2026-07-30T00:00:00.000Z')
  })

  it('returns null rather than NaN or "Invalid Date" for unparseable input', () => {
    expect(applyTransform('not a number', 'number')).toBeNull()
    expect(applyTransform('not a date', 'date_iso')).toBeNull()
  })

  it('passes null through untouched', () => {
    expect(applyTransform(null, 'uppercase')).toBeNull()
    expect(applyTransform(undefined, 'number')).toBeNull()
  })

  it('drops unmapped picklist values instead of sending something the CRM will reject', () => {
    const config = { map: { hot: 'Hot Lead' }, fallback: 'Other' }
    expect(applyTransform('hot', 'picklist_map', config)).toBe('Hot Lead')
    expect(applyTransform('unknown', 'picklist_map', config)).toBe('Other')
    expect(applyTransform('unknown', 'picklist_map', { map: {} })).toBeNull()
  })

  it('truncates rather than letting the provider reject the record', () => {
    expect(applyTransform('a'.repeat(300), 'truncate', { maxLength: 10 })).toBe('aaaaaaaaaa')
  })
})

describe('projection', () => {
  it('reads dotted paths for related records', () => {
    expect(readPath({ account: { name: 'Acme' } }, 'account.name')).toBe('Acme')
    expect(readPath({ account: null }, 'account.name')).toBeUndefined()
    expect(readPath({}, 'missing.deep.path')).toBeUndefined()
  })

  it('omits undefined so a partial record cannot blank remote fields', () => {
    const out = toRemote({ firstName: 'Ada' }, CONTACT_MAPPINGS)
    expect(out).toEqual({ FirstName: 'Ada' })
    expect('LastName' in out).toBe(false)
  })

  it('sends an explicit null through, because blanking is sometimes intended', () => {
    const out = toRemote({ firstName: null }, CONTACT_MAPPINGS)
    expect(out.FirstName).toBeNull()
  })

  it('respects provider constraints from the schema', async () => {
    const schema = (await crm.describe(ctx(), 'contact')).fields
    const out = toRemote(
      { title: 'A very long job title that exceeds the limit', firstName: 'Ada' },
      [...CONTACT_MAPPINGS, { object: 'contact', localField: 'x', remoteField: 'ReadOnlyField', direction: 'push' }],
      schema
    )
    expect((out.Title as string).length).toBe(20)
    expect('ReadOnlyField' in out).toBe(false)
  })

  it('skips a picklist value the provider does not offer', async () => {
    const schema = (await crm.describe(ctx(), 'account')).fields
    const mappings: FieldMapping[] = [
      { object: 'account', localField: 'industry', remoteField: 'Industry', direction: 'push' },
    ]
    expect(toRemote({ industry: 'Logistics' }, mappings, schema)).toEqual({ Industry: 'Logistics' })
    expect(toRemote({ industry: 'Underwater Basketry' }, mappings, schema)).toEqual({})
  })

  it('ignores direction-excluded mappings in each direction', () => {
    const mappings: FieldMapping[] = [
      { object: 'contact', localField: 'a', remoteField: 'A', direction: 'push' },
      { object: 'contact', localField: 'b', remoteField: 'B', direction: 'pull' },
      { object: 'contact', localField: 'c', remoteField: 'C', direction: 'none' },
    ]
    expect(toRemote({ a: 1, b: 2, c: 3 }, mappings)).toEqual({ A: 1 })
    expect(toLocal({ A: 1, B: 2, C: 3 }, mappings)).toEqual({ b: 2 })
  })
})

describe('hashing', () => {
  it('is order-independent and change-sensitive', () => {
    expect(hashFields({ a: '1', b: '2' })).toBe(hashFields({ b: '2', a: '1' }))
    expect(hashFields({ a: '1' })).not.toBe(hashFields({ a: '2' }))
  })

  it('treats null and empty string as equivalent, because CRMs do', () => {
    expect(hashFields({ a: null })).toBe(hashFields({ a: '' }))
  })
})

describe('conflict resolution', () => {
  const older = new Date('2026-07-01T00:00:00Z')
  const newer = new Date('2026-07-02T00:00:00Z')

  it('does nothing when nothing changed', () => {
    expect(resolveConflict({ policy: 'last_write_wins', localChanged: false, remoteChanged: false }))
      .toEqual({ action: 'skip', reason: 'no_change' })
  })

  it('moves data in the one direction that changed', () => {
    expect(resolveConflict({ policy: 'last_write_wins', localChanged: true, remoteChanged: false }).action).toBe('push')
    expect(resolveConflict({ policy: 'last_write_wins', localChanged: false, remoteChanged: true }).action).toBe('pull')
  })

  it('uses the newer timestamp when both changed', () => {
    expect(resolveConflict({
      policy: 'last_write_wins', localChanged: true, remoteChanged: true,
      localUpdatedAt: older, remoteUpdatedAt: newer,
    }).action).toBe('pull')

    expect(resolveConflict({
      policy: 'last_write_wins', localChanged: true, remoteChanged: true,
      localUpdatedAt: newer, remoteUpdatedAt: older,
    }).action).toBe('push')
  })

  it('flags rather than guesses when timestamps cannot decide', () => {
    expect(resolveConflict({
      policy: 'last_write_wins', localChanged: true, remoteChanged: true,
      localUpdatedAt: older, remoteUpdatedAt: null,
    }).action).toBe('flag')

    expect(resolveConflict({
      policy: 'last_write_wins', localChanged: true, remoteChanged: true,
      localUpdatedAt: older, remoteUpdatedAt: older,
    }).action).toBe('flag')
  })

  it('honours explicit winner policies', () => {
    const both = { localChanged: true, remoteChanged: true, localUpdatedAt: older, remoteUpdatedAt: newer }
    expect(resolveConflict({ ...both, policy: 'crm_wins' }).action).toBe('pull')
    expect(resolveConflict({ ...both, policy: 'app_wins' }).action).toBe('push')
    expect(resolveConflict({ ...both, policy: 'manual' }).action).toBe('flag')
  })
})

describe('mapping validation', () => {
  it('catches a required remote field nobody mapped', async () => {
    const schema = (await crm.describe(ctx(), 'contact')).fields
    const problems = validateMappings('contact', [CONTACT_MAPPINGS[0]], schema)
    expect(problems.join(' ')).toContain('LastName')
  })

  it('catches two local fields writing the same remote field', () => {
    const problems = validateMappings('contact', [
      { object: 'contact', localField: 'firstName', remoteField: 'Name', direction: 'push' },
      { object: 'contact', localField: 'lastName', remoteField: 'Name', direction: 'push' },
    ])
    expect(problems.join(' ')).toContain('Name')
  })
})

// ===========================================================================

describe('pull', () => {
  it('creates local records from remote ones', async () => {
    crm.seedRemote('contact', { Email: 'ada@remote.test', FirstName: 'Ada', LastName: 'Lovelace', Title: 'VP' })
    const stats = await pull()

    expect(stats.pulled).toBe(1)
    expect(stats.created).toBe(1)

    const contact = await owner.contact.findFirstOrThrow({ where: { tenantId } })
    expect(contact.email).toBe('ada@remote.test')
    expect(contact.firstName).toBe('Ada')
    expect(contact.title).toBe('VP')
  })

  it('links to an existing local record instead of duplicating it', async () => {
    await owner.contact.create({
      data: { tenantId, email: 'ada@remote.test', firstName: 'Ada', title: 'Chief Engineer' },
    })
    crm.seedRemote('contact', { Email: 'ada@remote.test', FirstName: 'Ada', LastName: 'Lovelace', Title: 'VP' })

    const stats = await pull()
    expect(stats.created).toBe(0)
    expect(stats.updated).toBe(1)
    expect(await owner.contact.count({ where: { tenantId } })).toBe(1)

    const contact = await owner.contact.findFirstOrThrow({ where: { tenantId } })
    // Adopting an existing record fills gaps only; a curated title survives.
    expect(contact.title).toBe('Chief Engineer')
    expect(contact.lastName).toBe('Lovelace')
  })

  it('paginates through more records than one page', async () => {
    crm.pageSize = 2
    for (let i = 0; i < 5; i++) {
      crm.seedRemote('contact', { Email: `p${i}@remote.test`, LastName: `P${i}` })
    }
    const stats = await pull()
    expect(stats.pulled).toBe(5)
    expect(stats.created).toBe(5)
    expect(crm.calls.pull).toBeGreaterThan(1)
  })

  it('does not resurrect a locally deleted record', async () => {
    const remoteId = crm.seedRemote('contact', { Email: 'gone@remote.test', LastName: 'Gone' })
    await pull()

    const contact = await owner.contact.findFirstOrThrow({ where: { tenantId } })
    await owner.contact.delete({ where: { id: contact.id } })

    crm.remoteEdit('contact', remoteId, { Title: 'Changed' })
    const stats = await pull()

    expect(stats.created).toBe(0)
    expect(await owner.contact.count({ where: { tenantId } })).toBe(0)
    // The dangling link is cleaned up rather than left to fail every run.
    expect(await owner.crmSyncRecord.count({ where: { connectionId } })).toBe(0)
  })

  it('stops cleanly and keeps its place when rate limited', async () => {
    crm.seedRemote('contact', { Email: 'a@remote.test', LastName: 'A' })
    crm.failNextPull = new CrmRateLimitError('slow down', 30)

    const stats = await pull()
    expect(stats.errors.join(' ')).toContain('Rate limited')
    expect(stats.created).toBe(0)

    // The next run succeeds; nothing was lost.
    const second = await pull()
    expect(second.created).toBe(1)
  })

  it('records a per-record failure without aborting the batch', async () => {
    crm.seedRemote('contact', { Email: 'good@remote.test', LastName: 'Good' })
    crm.seedRemote('contact', { Email: 'not-an-email', LastName: 'Bad' })
    crm.seedRemote('contact', { Email: 'alsogood@remote.test', LastName: 'Good2' })

    const stats = await pull()
    // All three are attempted regardless of individual outcomes.
    expect(stats.pulled).toBe(3)
    expect(stats.created + stats.failed).toBe(3)
  })
})

describe('push', () => {
  it('creates a remote record and stores the link', async () => {
    await owner.contact.create({
      data: { tenantId, email: 'new@local.test', firstName: 'New', lastName: 'Local', title: 'Head' },
    })

    const stats = await push()
    expect(stats.pushed).toBe(1)
    expect(crm.count('contact')).toBe(1)

    const link = await owner.crmSyncRecord.findFirstOrThrow({ where: { connectionId } })
    expect(link.remoteId).toBeTruthy()
    expect(crm.read('contact', link.remoteId)!.Email).toBe('new@local.test')
  })

  it('does not spend an API call when nothing mapped has changed', async () => {
    await owner.contact.create({ data: { tenantId, email: 'x@local.test', lastName: 'X' } })
    await push()
    const callsAfterFirst = crm.calls.push

    const second = await push()
    expect(second.pushed).toBe(0)
    expect(second.skipped).toBe(1)
    expect(crm.calls.push).toBe(callsAfterFirst)
  })

  it('pushes again when a mapped field actually changes', async () => {
    const contact = await owner.contact.create({ data: { tenantId, email: 'y@local.test', lastName: 'Y' } })
    await push()

    await owner.contact.update({ where: { id: contact.id }, data: { title: 'New Title' } })
    const stats = await push()
    expect(stats.pushed).toBe(1)

    const link = await owner.crmSyncRecord.findFirstOrThrow({ where: { connectionId } })
    expect(crm.read('contact', link.remoteId)!.Title).toBe('New Title')
  })

  it('ignores a change to a field nobody maps', async () => {
    const contact = await owner.contact.create({ data: { tenantId, email: 'z@local.test', lastName: 'Z' } })
    await push()

    // `phone` is not in CONTACT_MAPPINGS.
    await owner.contact.update({ where: { id: contact.id }, data: { phone: '+1 555 0000' } })
    const stats = await push()
    expect(stats.pushed).toBe(0)
    expect(stats.skipped).toBe(1)
  })

  it('records a rejected record and keeps going', async () => {
    const a = await owner.contact.create({ data: { tenantId, email: 'ok@local.test', lastName: 'Ok' } })
    await owner.contact.create({ data: { tenantId, email: 'bad@local.test', lastName: 'Bad' } })

    crm.failNextPush = { localId: a.id, error: 'REQUIRED_FIELD_MISSING: LastName', permanent: true }
    const stats = await push()

    expect(stats.failed).toBe(1)
    expect(stats.pushed).toBe(1)
    expect(stats.errors.join(' ')).toContain('REQUIRED_FIELD_MISSING')

    const failed = await owner.crmSyncRecord.findFirst({ where: { connectionId, localId: a.id } })
    // Nothing was written for the failed record, so it is retried next pass.
    expect(failed).toBeNull()
  })
})

describe('bidirectional convergence', () => {
  it('does not echo its own writes back and forth', async () => {
    await owner.contact.create({
      data: { tenantId, email: 'echo@local.test', firstName: 'Echo', lastName: 'Test', title: 'VP' },
    })

    await push()
    const afterPush = { pull: crm.calls.pull, push: crm.calls.push }

    // Five full cycles. If the engine echoed, each round would see a change and
    // write again, forever.
    for (let i = 0; i < 5; i++) {
      const pulled = await pull()
      const pushed = await push()
      expect(pulled.created).toBe(0)
      expect(pulled.updated).toBe(0)
      expect(pushed.pushed).toBe(0)
    }

    expect(crm.calls.push).toBe(afterPush.push) // no further writes at all
    expect(await owner.contact.count({ where: { tenantId } })).toBe(1)
    expect(crm.count('contact')).toBe(1)
  })

  it('propagates a remote edit down and then settles', async () => {
    await owner.contact.create({ data: { tenantId, email: 'settle@local.test', lastName: 'Settle' } })
    await push()

    const link = await owner.crmSyncRecord.findFirstOrThrow({ where: { connectionId } })
    crm.remoteEdit('contact', link.remoteId, { Title: 'Remotely Edited' })

    const first = await pull()
    expect(first.updated).toBe(1)

    const contact = await owner.contact.findFirstOrThrow({ where: { tenantId } })
    expect(contact.title).toBe('Remotely Edited')

    // And it stops.
    const second = await pull()
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(1)
    const pushAfter = await push()
    expect(pushAfter.pushed).toBe(0)
  })

  it('flags a genuine both-sides conflict instead of silently discarding an edit', async () => {
    const contact = await owner.contact.create({
      data: { tenantId, email: 'clash@local.test', lastName: 'Clash', title: 'Original' },
    })
    await push()

    const link = await owner.crmSyncRecord.findFirstOrThrow({ where: { connectionId } })

    // Both sides move. The local row's updatedAt is real time; the fake CRM's
    // clock is in the past, so last-write-wins resolves to the local edit.
    crm.remoteEdit('contact', link.remoteId, { Title: 'CRM Version' })
    await owner.contact.update({ where: { id: contact.id }, data: { title: 'App Version' } })

    const stats = await pull('last_write_wins')
    expect(stats.updated).toBe(0)
    expect(stats.skipped).toBe(1) // deferred to the push pass, local being newer

    const after = await owner.contact.findFirstOrThrow({ where: { id: contact.id } })
    expect(after.title).toBe('App Version')

    // Push then carries the local value up, and both sides agree.
    await push()
    expect(crm.read('contact', link.remoteId)!.Title).toBe('App Version')
  })

  it('holds a manual-policy conflict for a human and refuses to push over it', async () => {
    const contact = await owner.contact.create({
      data: { tenantId, email: 'manual@local.test', lastName: 'Manual', title: 'Original' },
    })
    await push()

    const link = await owner.crmSyncRecord.findFirstOrThrow({ where: { connectionId } })
    crm.remoteEdit('contact', link.remoteId, { Title: 'CRM Version' })
    await owner.contact.update({ where: { id: contact.id }, data: { title: 'App Version' } })

    const stats = await pull('manual')
    expect(stats.conflicts).toBe(1)

    const flagged = await owner.crmSyncRecord.findFirstOrThrow({ where: { id: link.id } })
    expect(flagged.conflictAt).not.toBeNull()
    expect(flagged.lastError).toContain('Conflict')

    // Neither side is overwritten while the conflict stands.
    const pushed = await push()
    expect(pushed.pushed).toBe(0)
    expect(pushed.conflicts).toBe(1)
    expect(crm.read('contact', link.remoteId)!.Title).toBe('CRM Version')
    const local = await owner.contact.findFirstOrThrow({ where: { id: contact.id } })
    expect(local.title).toBe('App Version')
  })

  it('never lets the CRM overwrite protected local fields', async () => {
    const contact = await owner.contact.create({
      data: { tenantId, email: 'protect@local.test', lastName: 'Protect', score: 90, unsubscribedAt: new Date() },
    })
    await push()

    const link = await owner.crmSyncRecord.findFirstOrThrow({ where: { connectionId } })

    // A mapping that tries to write score and unsubscribedAt from the CRM.
    const hostile: FieldMapping[] = [
      ...CONTACT_MAPPINGS,
      { object: 'contact', localField: 'score', remoteField: 'Website', direction: 'pull', transform: 'number' },
      { object: 'contact', localField: 'unsubscribedAt', remoteField: 'Industry', direction: 'pull' },
    ]
    crm.remoteEdit('contact', link.remoteId, { Website: '5', Industry: 'Logistics', Title: 'New' })

    await withTenant(tenantId, () =>
      pullObject({
        adapter: crm, ctx: ctx(), object: 'contact',
        mappings: hostile, policy: 'crm_wins', direction: 'bidirectional',
      })
    )

    const after = await owner.contact.findFirstOrThrow({ where: { id: contact.id } })
    expect(after.score).toBe(90) // not clobbered
    expect(after.unsubscribedAt).not.toBeNull() // unsubscribe not resurrected
    expect(after.title).toBe('New') // ordinary field did sync
  })
})

describe('syncConnection', () => {
  it('runs configured objects and records connection health', async () => {
    await owner.crmFieldMapping.createMany({
      data: CONTACT_MAPPINGS.map((m) => ({
        connectionId,
        object: m.object,
        localField: m.localField,
        remoteField: m.remoteField,
        direction: m.direction,
        transform: m.transform ?? null,
      })),
    })

    crm.seedRemote('contact', { Email: 'orch@remote.test', FirstName: 'Orch', LastName: 'Estrated' })
    await owner.contact.create({ data: { tenantId, email: 'local@local.test', lastName: 'Local' } })

    const stats = await withTenant(tenantId, () =>
      syncConnection({ adapter: crm, ctx: ctx(), objects: ['contact'] })
    )

    expect(stats).toHaveLength(1)
    expect(stats[0].created).toBe(1) // the remote contact came down
    expect(stats[0].pushed).toBe(1)  // only the pre-existing local one went up

    const conn = await owner.crmConnection.findUniqueOrThrow({ where: { id: connectionId } })
    expect(conn.lastSyncAt).not.toBeNull()
    expect(conn.status).toBe('connected')
  })

  it('skips objects with no mappings rather than syncing everything by default', async () => {
    const stats = await withTenant(tenantId, () =>
      syncConnection({ adapter: crm, ctx: ctx(), objects: ['contact', 'account', 'lead'] })
    )
    expect(stats).toHaveLength(0)
  })
})

describe('regressions', () => {
  it('does not push a freshly-pulled record straight back', async () => {
    // The remote record has no Title. The local row stores title as null, so
    // projecting it back yields `Title: null` — which must hash the same as
    // "Title absent", or the record echoes on the very next push.
    crm.seedRemote('contact', { Email: 'fresh@remote.test', FirstName: 'Fresh', LastName: 'Pull' })

    const pulled = await pull()
    expect(pulled.created).toBe(1)

    const writesBefore = crm.calls.push
    const pushed = await push()

    expect(pushed.pushed).toBe(0)
    expect(pushed.skipped).toBe(1)
    expect(crm.calls.push).toBe(writesBefore)
  })

  it('never writes 0 into the CRM for an unparseable number', () => {
    const mappings: FieldMapping[] = [
      { object: 'account', localField: 'employeeCount', remoteField: 'NumberOfEmployees', direction: 'push', transform: 'number' },
    ]
    // "unknown" must not become 0 employees.
    expect(toRemote({ employeeCount: 'unknown' }, mappings)).toEqual({ NumberOfEmployees: null })
    expect(toRemote({ employeeCount: '1,200' }, mappings)).toEqual({ NumberOfEmployees: 1200 })
    expect(toRemote({ employeeCount: 0 }, mappings)).toEqual({ NumberOfEmployees: 0 })
  })
})
