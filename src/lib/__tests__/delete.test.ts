import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant } from '../db'
import {
  previewContactDelete, deleteContacts,
  previewAccountDelete, deleteAccount,
  previewSequenceDelete, deleteSequence,
  previewTemplateDelete, deleteTemplate,
} from '../delete'

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
let userId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'delete-test' }, update: {},
    create: { slug: 'delete-test', name: 'Delete Test Co' },
  })
  tenantId = t.id
  const u = await owner.user.upsert({
    where: { tenantId_email: { tenantId, email: 'rep@delete.test' } }, update: {},
    create: { tenantId, email: 'rep@delete.test', name: 'Rep', role: 'rep', status: 'active' },
  })
  userId = u.id
})

beforeEach(async () => {
  await owner.suppressionEntry.deleteMany({ where: { tenantId } })
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.emailMessage.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.sequenceStep.deleteMany({ where: { sequence: { tenantId } } })
  await owner.sequence.deleteMany({ where: { tenantId } })
  await owner.emailTemplate.deleteMany({ where: { tenantId } })
  await owner.deal.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
})

afterAll(async () => {
  await owner.suppressionEntry.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.account.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

const contact = (over: Record<string, unknown> = {}) =>
  owner.contact.create({ data: { tenantId, firstName: 'Dana', lastName: 'Reid', email: `d${Math.random().toString(36).slice(2, 8)}@example.test`, ...over } })

describe('deleting a contact', () => {
  it('says what else goes with them', async () => {
    const c = await contact()
    await owner.activity.createMany({
      data: [
        { tenantId, type: 'note', summary: 'a', contactId: c.id },
        { tenantId, type: 'note', summary: 'b', contactId: c.id },
      ],
    })
    await owner.task.create({ data: { tenantId, type: 'follow_up', title: 't', contactId: c.id } })

    const p = await withTenant(tenantId, () => previewContactDelete([c.id]))
    expect(p.label).toBe('Dana Reid')
    expect(p.alsoRemoved).toEqual(
      expect.arrayContaining([
        { what: 'timeline entries', count: 2 },
        { what: 'task', count: 1 },
      ])
    )
    // Nothing with a zero count — "0 deals" is noise in a confirmation.
    expect(p.alsoRemoved.every((x) => x.count > 0)).toBe(true)
  })

  it('actually removes the contact and its history', async () => {
    const c = await contact()
    await owner.activity.create({ data: { tenantId, type: 'note', summary: 'x', contactId: c.id } })

    const r = await withTenant(tenantId, () => deleteContacts([c.id]))
    expect(r.deleted).toBe(1)
    expect(await owner.contact.count({ where: { id: c.id } })).toBe(0)
    expect(await owner.activity.count({ where: { contactId: c.id } })).toBe(0)
  })

  it('keeps someone suppressed after their record is deleted', async () => {
    // The failure this prevents: delete a contact who told you to stop, re-import
    // the same list next month, and start emailing them again.
    const c = await contact({ email: 'stop@example.test', unsubscribedAt: new Date() })
    await withTenant(tenantId, () => deleteContacts([c.id]))

    const entry = await owner.suppressionEntry.findFirst({
      where: { tenantId, value: 'stop@example.test' },
    })
    expect(entry).not.toBeNull()
    expect(entry!.reason).toBe('unsubscribe')
  })

  it('suppresses a do-not-contact who never had an entry of their own', async () => {
    // Marking someone do-not-contact by hand writes no suppression entry, so this
    // is the case where deletion would quietly undo the decision.
    const c = await contact({ email: 'manual@example.test', status: 'do_not_contact' })
    await withTenant(tenantId, () => deleteContacts([c.id]))

    const entry = await owner.suppressionEntry.findFirstOrThrow({
      where: { tenantId, value: 'manual@example.test' },
    })
    expect(entry.reason).toBe('manual')
  })

  it('leaves an ordinary contact unsuppressed', async () => {
    // Deleting a duplicate must not blacklist the address.
    const c = await contact({ email: 'fine@example.test' })
    await withTenant(tenantId, () => deleteContacts([c.id]))
    expect(await owner.suppressionEntry.count({ where: { tenantId } })).toBe(0)
  })

  it('deletes several at once', async () => {
    const cs = await Promise.all([contact(), contact(), contact()])
    const r = await withTenant(tenantId, () => deleteContacts(cs.map((c) => c.id)))
    expect(r.deleted).toBe(3)
  })
})

describe('deleting an account', () => {
  it('keeps the people, loses the company', async () => {
    // People at a company you stop tracking are still people you know.
    const a = await owner.account.create({ data: { tenantId, name: 'Northgate', domain: 'n.test' } })
    const c = await contact({ accountId: a.id })

    const p = await withTenant(tenantId, () => previewAccountDelete(a.id))
    expect(p.sideEffects.join(' ')).toMatch(/1 contact will stay, without a company/)

    await withTenant(tenantId, () => deleteAccount(a.id))
    const after = await owner.contact.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.accountId).toBeNull()
  })
})

describe('deleting an account and its people', () => {
  it('offers the choice rather than guessing', async () => {
    // Deleting a company because the record was junk should take its people;
    // deleting one because you stopped tracking them should not. Either default
    // is wrong half the time.
    const a = await owner.account.create({ data: { tenantId, name: 'Junk Co', domain: 'j.test' } })
    await contact({ accountId: a.id })
    await contact({ accountId: a.id })

    const p = await withTenant(tenantId, () => previewAccountDelete(a.id))
    expect(p.option).toMatchObject({ key: 'cascadeContacts', count: 2 })
    expect(p.option!.label).toMatch(/Also delete the 2 contacts/)
  })

  it('restates the cost when the option is taken', async () => {
    const a = await owner.account.create({ data: { tenantId, name: 'Junk Co', domain: 'j2.test' } })
    const c = await contact({ accountId: a.id })
    await owner.activity.createMany({
      data: [
        { tenantId, type: 'note', summary: 'a', contactId: c.id },
        { tenantId, type: 'note', summary: 'b', contactId: c.id },
      ],
    })

    const off = await withTenant(tenantId, () => previewAccountDelete(a.id))
    expect(off.sideEffects.join(' ')).toMatch(/will stay, without a company/)

    const on = await withTenant(tenantId, () =>
      previewAccountDelete(a.id, { cascadeContacts: true })
    )
    // The contacts' own collateral becomes the account's collateral.
    expect(on.alsoRemoved).toEqual(
      expect.arrayContaining([
        { what: 'contact', count: 1 },
        { what: 'timeline entries', count: 2 },
      ])
    )
    expect(on.sideEffects.join(' ')).not.toMatch(/will stay/)
  })

  it('removes the people when asked', async () => {
    const a = await owner.account.create({ data: { tenantId, name: 'Junk Co', domain: 'j3.test' } })
    await contact({ accountId: a.id })
    await contact({ accountId: a.id })

    const r = await withTenant(tenantId, () => deleteAccount(a.id, { cascadeContacts: true }))
    expect(r.contactsDeleted).toBe(2)
    expect(await owner.contact.count({ where: { tenantId } })).toBe(0)
    expect(await owner.account.count({ where: { id: a.id } })).toBe(0)
  })

  it('still preserves suppression when it cascades', async () => {
    // Deleting a company must not become a way to un-unsubscribe everyone who
    // works there.
    const a = await owner.account.create({ data: { tenantId, name: 'Junk Co', domain: 'j4.test' } })
    await contact({ accountId: a.id, email: 'gone@example.test', unsubscribedAt: new Date() })

    await withTenant(tenantId, () => deleteAccount(a.id, { cascadeContacts: true }))
    const entry = await owner.suppressionEntry.findFirstOrThrow({
      where: { tenantId, value: 'gone@example.test' },
    })
    expect(entry.reason).toBe('unsubscribe')
  })

  it('offers nothing when the company has nobody', async () => {
    const a = await owner.account.create({ data: { tenantId, name: 'Empty Co', domain: 'e.test' } })
    const p = await withTenant(tenantId, () => previewAccountDelete(a.id))
    expect(p.option).toBeUndefined()
  })
})

describe('deleting a campaign', () => {
  async function campaign(status: 'active' | 'paused', enrol: number) {
    const s = await owner.sequence.create({
      data: { tenantId, name: 'Legal tech', status, createdById: userId },
    })
    await owner.sequenceStep.create({ data: { sequenceId: s.id, order: 0, type: 'email' } })
    for (let i = 0; i < enrol; i++) {
      const c = await contact()
      await owner.sequenceEnrollment.create({
        data: { tenantId, sequenceId: s.id, contactId: c.id, status: 'active' },
      })
    }
    return s
  }

  it('refuses while it is still working people', async () => {
    // Deleting a running campaign out from under people mid-sequence is not
    // something to infer from a click on a bin icon.
    const s = await campaign('active', 2)
    const p = await withTenant(tenantId, () => previewSequenceDelete(s.id))
    expect(p.blockers).toHaveLength(1)
    expect(p.blockers[0]).toMatch(/Pause it first/)
  })

  it('allows it once paused', async () => {
    const s = await campaign('paused', 2)
    const p = await withTenant(tenantId, () => previewSequenceDelete(s.id))
    expect(p.blockers).toEqual([])

    await withTenant(tenantId, () => deleteSequence(s.id))
    expect(await owner.sequence.count({ where: { id: s.id } })).toBe(0)
  })

  it('leaves the contacts alone', async () => {
    const s = await campaign('paused', 2)
    const before = await owner.contact.count({ where: { tenantId } })
    await withTenant(tenantId, () => deleteSequence(s.id))
    expect(await owner.contact.count({ where: { tenantId } })).toBe(before)
  })

  it('does not block an active campaign nobody is in', async () => {
    const s = await campaign('active', 0)
    const p = await withTenant(tenantId, () => previewSequenceDelete(s.id))
    expect(p.blockers).toEqual([])
  })
})

describe('deleting a template', () => {
  it('names the campaigns that used it', async () => {
    const t = await owner.emailTemplate.create({
      data: { tenantId, name: 'First touch', subject: 's', bodyHtml: '<p>b</p>', bodyText: 'b', createdById: userId },
    })
    const s = await owner.sequence.create({
      data: { tenantId, name: 'Legal tech', status: 'paused', createdById: userId },
    })
    await owner.sequenceStep.create({
      data: { sequenceId: s.id, order: 0, type: 'email', templateId: t.id },
    })

    const p = await withTenant(tenantId, () => previewTemplateDelete(t.id))
    expect(p.sideEffects.join(' ')).toMatch(/Legal tech/)
    expect(p.blockers).toEqual([])

    // The step keeps its own copy — a template is a starting point, not a link.
    await withTenant(tenantId, () => deleteTemplate(t.id))
    expect(await owner.sequenceStep.count({ where: { sequenceId: s.id } })).toBe(1)
  })
})
