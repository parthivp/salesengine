import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant, db } from '../db'
import { processEnrollmentStep, enrollContacts, recordReply } from '../../worker/jobs/sequence'

/**
 * End-to-end tests for the sequence engine against real Postgres.
 *
 * These are the tests that matter most in the whole project. A double-send to a
 * prospect, or an email that goes out after someone replied, is the kind of bug
 * that loses the customer rather than filing a ticket. Every one below encodes a
 * failure mode that a naive implementation actually exhibits.
 *
 * No mailbox is configured with real credentials, so sends resolve through
 * logTransport — the engine's behaviour is identical, nothing leaves the box.
 */

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
let mailboxId: string
let sequenceId: string
let contactId: string
let userId: string

async function wipe() {
  await owner.emailEvent.deleteMany({ where: { message: { tenantId } } })
  await owner.emailMessage.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.suppressionEntry.deleteMany({ where: { tenantId } })
  await owner.contact.update({
    where: { id: contactId },
    data: {
      unsubscribedAt: null, bouncedAt: null, lastRepliedAt: null,
      status: 'new', lastContactedAt: null,
    },
  })
  await owner.mailbox.update({
    where: { id: mailboxId },
    data: { sentToday: 0, sentTodayOn: null, dailyCap: 50, health: 'healthy' },
  })
}

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'seq-test' },
    update: {},
    create: { slug: 'seq-test', name: 'Sequence Test Co' },
  })
  tenantId = t.id

  const user = await owner.user.upsert({
    where: { tenantId_email: { tenantId, email: 'rep@seqtest.test' } },
    update: {},
    create: {
      tenantId, email: 'rep@seqtest.test', name: 'Test Rep',
      role: 'rep', status: 'active',
    },
  })
  userId = user.id

  const mailbox = await owner.mailbox.upsert({
    where: { tenantId_email: { tenantId, email: 'outbound@seqtest.test' } },
    update: { health: 'healthy', dailyCap: 50, sentToday: 0, sentTodayOn: null },
    create: {
      tenantId, provider: 'ses', email: 'outbound@seqtest.test',
      fromName: 'Test Rep', health: 'healthy', dailyCap: 50,
      spfOk: true, dkimOk: true,
    },
  })
  mailboxId = mailbox.id

  const account = await owner.account.upsert({
    where: { tenantId_domain: { tenantId, domain: 'prospect.test' } },
    update: {},
    create: { tenantId, name: 'Prospect Inc', domain: 'prospect.test', employeeCount: 300 },
  })

  const contact = await owner.contact.upsert({
    where: { tenantId_email: { tenantId, email: 'buyer@prospect.test' } },
    update: {},
    create: {
      tenantId, email: 'buyer@prospect.test', firstName: 'Bo', lastName: 'Yer',
      title: 'VP of Sales', accountId: account.id, ownerId: user.id,
      // A 24/7 window keeps the tests independent of when they happen to run.
      timezone: 'UTC',
    },
  })
  contactId = contact.id

  const sequence = await owner.sequence.upsert({
    where: { tenantId_name: { tenantId, name: 'Test sequence' } },
    update: { status: 'active' },
    create: {
      tenantId, name: 'Test sequence', status: 'active',
      sendWindowStart: 0, sendWindowEnd: 24, sendDays: [0, 1, 2, 3, 4, 5, 6],
      stopOnReply: true, stopOnAccountReply: true,
    },
  })
  sequenceId = sequence.id

  await owner.sequenceStep.deleteMany({ where: { sequenceId } })
  await owner.sequenceStep.createMany({
    data: [
      {
        sequenceId, order: 1, type: 'email', delayMinutes: 0,
        subject: 'Quick question, {{first_name}}',
        bodyText: 'Hi {{first_name}}, noticed {{company}} is scaling. Worth a chat?',
      },
      {
        sequenceId, order: 2, type: 'email', delayMinutes: 0,
        subject: 'Following up',
        bodyText: 'Hi {{first_name}}, bumping this in case it slipped.',
        conditions: { type: 'if_no_reply' },
      },
    ],
  })
})

beforeEach(wipe)

afterAll(async () => {
  await wipe()
  await owner.$disconnect()
})

async function enrol() {
  await enrollContacts({ tenantId, sequenceId, contactIds: [contactId], enrolledById: userId })
  const e = await owner.sequenceEnrollment.findFirstOrThrow({ where: { tenantId, contactId } })
  // Make it due now regardless of jitter.
  await owner.sequenceEnrollment.update({ where: { id: e.id }, data: { nextRunAt: new Date() } })
  return e.id
}

describe('enrollment', () => {
  it('enrols an eligible contact at step 1', async () => {
    const id = await enrol()
    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.status).toBe('active')
    expect(e.stepIndex).toBe(0)
    expect(e.nextRunAt).not.toBeNull()
  })

  it('will not enrol the same contact twice', async () => {
    await enrol()
    const second = await enrollContacts({ tenantId, sequenceId, contactIds: [contactId] })
    expect(second.enrolled).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('refuses to enrol an unsubscribed contact', async () => {
    await owner.contact.update({ where: { id: contactId }, data: { unsubscribedAt: new Date() } })
    const r = await enrollContacts({ tenantId, sequenceId, contactIds: [contactId] })
    expect(r.enrolled).toBe(0)
  })

  it('refuses to enrol a do-not-contact contact', async () => {
    await owner.contact.update({ where: { id: contactId }, data: { status: 'do_not_contact' } })
    const r = await enrollContacts({ tenantId, sequenceId, contactIds: [contactId] })
    expect(r.enrolled).toBe(0)
  })
})

describe('sending', () => {
  it('sends step 1, renders merge tags, and advances', async () => {
    const id = await enrol()
    const result = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(result).toMatchObject({ sent: true })

    const messages = await owner.emailMessage.findMany({ where: { tenantId, direction: 'outbound' } })
    expect(messages).toHaveLength(1)
    expect(messages[0].status).toBe('sent')
    expect(messages[0].subject).toBe('Quick question, Bo')
    expect(messages[0].bodyText).toContain('Prospect Inc')
    expect(messages[0].bodyText).not.toContain('{{')

    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.stepIndex).toBe(1)
    expect(e.status).toBe('active')
    expect(e.lockedAt).toBeNull()
  })

  it('includes a working unsubscribe link and List-Unsubscribe URL', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })
    const m = await owner.emailMessage.findFirstOrThrow({ where: { tenantId, direction: 'outbound' } })
    expect(m.bodyHtml).toContain(`/e/u/${m.id}/`)
    expect(m.bodyText).toContain('Unsubscribe:')
  })

  it('counts the send against the mailbox cap', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })
    const mb = await owner.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })
    expect(mb.sentToday).toBe(1)
    expect(mb.sentTodayOn).not.toBeNull()
  })

  it('logs an activity and marks the contact as being worked', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })
    const acts = await owner.activity.findMany({ where: { tenantId, contactId } })
    expect(acts.some((a) => a.type === 'email_sent')).toBe(true)
    const c = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(c.status).toBe('working')
    expect(c.lastContactedAt).not.toBeNull()
  })
})

describe('never double-sends', () => {
  it('a second run of the same step does not send twice', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })

    // Simulate a duplicated job: rewind the index and make it due again, which
    // is the worst case — the enrollment genuinely looks like it owes step 1.
    await owner.sequenceEnrollment.update({
      where: { id },
      data: { stepIndex: 0, nextRunAt: new Date(), lockedAt: null },
    })

    const second = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(second).toMatchObject({ reason: 'already_sent' })

    const sent = await owner.emailMessage.count({
      where: { tenantId, direction: 'outbound', status: 'sent' },
    })
    expect(sent).toBe(1)
  })

  it('holds a lock so a concurrent worker cannot also send', async () => {
    const id = await enrol()

    // Both start at the same moment, as two workers pulling the same job would.
    const [a, b] = await Promise.all([
      processEnrollmentStep({ enrollmentId: id, tenantId }),
      processEnrollmentStep({ enrollmentId: id, tenantId }),
    ])

    const outcomes = [a, b]
    const sends = outcomes.filter((o) => (o as { sent?: boolean }).sent === true)
    expect(sends).toHaveLength(1)

    const messages = await owner.emailMessage.count({
      where: { tenantId, direction: 'outbound', status: 'sent' },
    })
    expect(messages).toBe(1)
  })

  it('enforces a unique idempotency key at the database level', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })
    const m = await owner.emailMessage.findFirstOrThrow({ where: { tenantId } })

    // Even a direct insert bypassing the engine cannot duplicate the key.
    await expect(
      owner.emailMessage.create({
        data: {
          tenantId, direction: 'outbound', status: 'queued',
          fromEmail: 'a@b.test', toEmail: 'c@d.test', subject: 'dupe',
          idempotencyKey: m.idempotencyKey!,
        },
      })
    ).rejects.toThrow()
  })
})

describe('never sends after a stop signal', () => {
  it('stops when the contact replies', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })

    await recordReply({
      tenantId, contactId, subject: 'Re: Quick question',
      bodyText: 'Interested — send pricing.',
    })

    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.status).toBe('stopped_replied')
    expect(e.nextRunAt).toBeNull()

    // Force it due anyway; the engine must still refuse.
    await owner.sequenceEnrollment.update({ where: { id }, data: { nextRunAt: new Date() } })
    const after = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(after).toMatchObject({ reason: 'status_stopped_replied' })

    const sent = await owner.emailMessage.count({
      where: { tenantId, direction: 'outbound', status: 'sent' },
    })
    expect(sent).toBe(1)
  })

  it('creates a follow-up task and re-engages the contact on reply', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId })
    await recordReply({ tenantId, contactId, subject: 'Re: hi', bodyText: 'Tell me more.' })

    const tasks = await owner.task.findMany({ where: { tenantId, contactId } })
    expect(tasks.some((t) => t.type === 'follow_up')).toBe(true)

    const c = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(c.status).toBe('engaged')
    expect(c.lastRepliedAt).not.toBeNull()
  })

  it('stops when a colleague at the same account replies', async () => {
    const account = await owner.account.findFirstOrThrow({
      where: { tenantId, domain: 'prospect.test' },
    })
    const colleague = await owner.contact.create({
      data: {
        tenantId, email: 'colleague@prospect.test', firstName: 'Col',
        accountId: account.id, lastRepliedAt: new Date(),
      },
    })

    const id = await enrol()
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'stop' })

    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.status).toBe('stopped_replied')
    expect(e.stopReason).toContain('account')

    await owner.contact.delete({ where: { id: colleague.id } })
  })

  it('stops on unsubscribe', async () => {
    const id = await enrol()
    await owner.contact.update({ where: { id: contactId }, data: { unsubscribedAt: new Date() } })
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'stop', status: 'stopped_unsubscribed' })
    expect(await owner.emailMessage.count({ where: { tenantId } })).toBe(0)
  })

  it('stops on a previous bounce', async () => {
    const id = await enrol()
    await owner.contact.update({ where: { id: contactId }, data: { bouncedAt: new Date() } })
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ status: 'stopped_bounced' })
  })

  it('respects an address-level suppression entry', async () => {
    const id = await enrol()
    await withTenant(tenantId, () =>
      db().suppressionEntry.create({
        data: { tenantId, type: 'email', value: 'buyer@prospect.test', reason: 'manual' },
      })
    )
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ status: 'stopped_unsubscribed' })
    expect(await owner.emailMessage.count({ where: { tenantId } })).toBe(0)
  })

  it('respects a domain-level suppression entry', async () => {
    const id = await enrol()
    await withTenant(tenantId, () =>
      db().suppressionEntry.create({
        data: { tenantId, type: 'domain', value: 'prospect.test', reason: 'manual' },
      })
    )
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ status: 'stopped_unsubscribed' })
  })
})

describe('capacity and scheduling', () => {
  it('defers instead of exceeding the daily cap', async () => {
    const id = await enrol()
    await owner.mailbox.update({
      where: { id: mailboxId },
      data: { dailyCap: 1, sentToday: 1, sentTodayOn: new Date() },
    })

    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'defer' })
    expect(await owner.emailMessage.count({ where: { tenantId } })).toBe(0)

    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.status).toBe('active') // deferred, not failed
    expect(e.nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('defers when no mailbox is available rather than failing the enrollment', async () => {
    const id = await enrol()
    await owner.mailbox.update({ where: { id: mailboxId }, data: { health: 'blocked' } })
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'defer' })
    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.status).toBe('active')
  })

  it('skips a step whose condition is not met and advances', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId }) // step 1 sends

    // Record a reply but keep the enrollment active, so only the step-2
    // `if_no_reply` condition is under test.
    await owner.emailMessage.create({
      data: {
        tenantId, direction: 'inbound', status: 'replied', contactId,
        fromEmail: 'buyer@prospect.test', toEmail: 'outbound@seqtest.test',
        subject: 'Re', bodyText: 'no thanks', repliedAt: new Date(),
      },
    })
    await owner.sequenceEnrollment.update({
      where: { id },
      data: { nextRunAt: new Date(), status: 'active' },
    })

    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'advanced' })

    // No second outbound email: the condition correctly suppressed it.
    const sent = await owner.emailMessage.count({
      where: { tenantId, direction: 'outbound', status: 'sent' },
    })
    expect(sent).toBe(1)
  })

  it('completes after the last step and stops being due', async () => {
    const id = await enrol()
    await processEnrollmentStep({ enrollmentId: id, tenantId }) // step 1
    await owner.sequenceEnrollment.update({ where: { id }, data: { nextRunAt: new Date() } })
    await processEnrollmentStep({ enrollmentId: id, tenantId }) // step 2, the last

    const e = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id } })
    expect(e.status).toBe('completed')
    expect(e.completedAt).not.toBeNull()
    // nextRunAt cleared, so the tick will never pick it up again.
    expect(e.nextRunAt).toBeNull()

    // And a stray job for a completed enrollment is a no-op, not a third send.
    const stray = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(stray).toMatchObject({ reason: 'status_completed' })
    const sent = await owner.emailMessage.count({
      where: { tenantId, direction: 'outbound', status: 'sent' },
    })
    expect(sent).toBe(2)
  })

  it('does not run while the sequence is paused', async () => {
    const id = await enrol()
    await owner.sequence.update({ where: { id: sequenceId }, data: { status: 'paused' } })
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'defer', reason: 'sequence_not_active' })
    expect(await owner.emailMessage.count({ where: { tenantId } })).toBe(0)
    await owner.sequence.update({ where: { id: sequenceId }, data: { status: 'active' } })
  })
})

describe('merge-tag safety', () => {
  it('fails the step rather than sending an unresolved tag to a prospect', async () => {
    const step = await owner.sequenceStep.findFirstOrThrow({ where: { sequenceId, order: 1 } })
    const original = step.bodyText

    await owner.sequenceStep.update({
      where: { id: step.id },
      data: { bodyText: 'Hi {{first_name}}, about {{favourite_colour}}...' },
    })

    const id = await enrol()
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ kind: 'stop', status: 'failed' })
    expect((outcome as { reason: string }).reason).toContain('favourite_colour')
    expect(await owner.emailMessage.count({ where: { tenantId } })).toBe(0)

    await owner.sequenceStep.update({ where: { id: step.id }, data: { bodyText: original } })
  })

  it('sends when the missing tag has a fallback', async () => {
    const step = await owner.sequenceStep.findFirstOrThrow({ where: { sequenceId, order: 1 } })
    const original = step.bodyText

    await owner.sequenceStep.update({
      where: { id: step.id },
      data: { bodyText: 'Hi {{first_name}}, saw {{industry | your team}} news.' },
    })

    const id = await enrol()
    const outcome = await processEnrollmentStep({ enrollmentId: id, tenantId })
    expect(outcome).toMatchObject({ sent: true })

    const m = await owner.emailMessage.findFirstOrThrow({ where: { tenantId } })
    expect(m.bodyText).toContain('your team')

    await owner.sequenceStep.update({ where: { id: step.id }, data: { bodyText: original } })
  })
})
