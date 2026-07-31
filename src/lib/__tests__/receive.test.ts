import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant, db } from '../db'
import { ingestInbound, isReply, normalizeSubject, tenantForInbound, type InboundMessage } from '../email/receive'

/**
 * Reply ingestion against real Postgres.
 *
 * The behaviour under test is the one that decides whether this system is safe to
 * point at a real pipeline: when someone writes back, does the machine stop, and
 * does it stop for the right reasons? A vacation responder that ends a sequence
 * and an opt-out that does not are both silent failures — nothing errors, the
 * numbers still look fine, and you find out weeks later.
 */

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

const NOW = new Date('2026-07-30T09:00:00Z')

let tenantId: string
let userId: string
let contactId: string
let mailboxId: string
let sequenceId: string

let seq = 0
function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  seq++
  return {
    messageId: `<in-${seq}-${Date.now()}@prospect.test>`,
    fromEmail: 'buyer@prospect.test',
    toEmail: 'rep@recvtest.test',
    subject: 'Re: Quick question',
    bodyText: 'Yes, interested — send pricing.',
    receivedAt: NOW,
    ...over,
  }
}

async function outbound(over: { messageId?: string; subject?: string; sentAt?: Date } = {}) {
  return withTenant(tenantId, () =>
    db().emailMessage.create({
      data: {
        tenantId,
        direction: 'outbound',
        status: 'sent',
        contactId,
        mailboxId,
        fromEmail: 'rep@recvtest.test',
        toEmail: 'buyer@prospect.test',
        subject: over.subject ?? 'Quick question',
        bodyText: 'Hello there.',
        messageId: over.messageId ?? `<out-${++seq}-${Date.now()}@recvtest.test>`,
        sentAt: over.sentAt ?? new Date(NOW.getTime() - 86_400_000),
      },
    })
  )
}

async function enroll(nextRunAt: Date) {
  return withTenant(tenantId, () =>
    db().sequenceEnrollment.create({
      data: { tenantId, sequenceId, contactId, status: 'active', stepIndex: 0, nextRunAt },
    })
  )
}

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'recv-test' },
    update: {},
    create: { slug: 'recv-test', name: 'Receive Test Co' },
  })
  tenantId = t.id

  const user = await owner.user.upsert({
    where: { tenantId_email: { tenantId, email: 'rep@recvtest.test' } },
    update: {},
    create: {
      tenantId, email: 'rep@recvtest.test', name: 'Recv Rep',
      passwordHash: 'x', role: 'rep', status: 'active',
    },
  })
  userId = user.id

  const mailbox = await owner.mailbox.findFirst({ where: { tenantId, email: 'rep@recvtest.test' } })
  mailboxId =
    mailbox?.id ??
    (await owner.mailbox.create({
      data: {
        tenantId, provider: 'smtp', email: 'rep@recvtest.test',
        fromName: 'Recv Rep', userId, health: 'healthy',
      },
    })).id

  const sequence = await owner.sequence.findFirst({ where: { tenantId, name: 'Recv Test Sequence' } })
  sequenceId =
    sequence?.id ??
    (await owner.sequence.create({
      data: { tenantId, name: 'Recv Test Sequence', status: 'active', createdById: userId },
    })).id

  const contact = await owner.contact.findFirst({ where: { tenantId, email: 'buyer@prospect.test' } })
  contactId =
    contact?.id ??
    (await owner.contact.create({
      data: {
        tenantId, email: 'buyer@prospect.test', firstName: 'Bo', lastName: 'Buyer',
        title: 'Head of Sales', ownerId: userId,
      },
    })).id
})

beforeEach(async () => {
  await owner.emailEvent.deleteMany({ where: { message: { tenantId } } })
  await owner.emailMessage.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.suppressionEntry.deleteMany({ where: { tenantId } })
  await owner.contact.update({
    where: { id: contactId },
    data: { status: 'new', unsubscribedAt: null, bouncedAt: null, lastRepliedAt: null, score: 0 },
  })
})

afterAll(async () => {
  await owner.emailEvent.deleteMany({ where: { message: { tenantId } } })
  await owner.emailMessage.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.suppressionEntry.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

describe('threading', () => {
  it('matches on In-Reply-To', async () => {
    const sent = await outbound({ messageId: '<abc@recvtest.test>' })
    const r = await ingestInbound(tenantId, inbound({ inReplyTo: '<abc@recvtest.test>' }), NOW)
    expect(r.ok).toBe(true)
    if (!isReply(r)) return
    expect(r.contactId).toBe(contactId)
    expect(r.actions[0]).toContain('In-Reply-To')

    const parent = await owner.emailMessage.findUniqueOrThrow({ where: { id: sent.id } })
    expect(parent.repliedAt).not.toBeNull()
  })

  it('walks the References chain when In-Reply-To misses', async () => {
    await outbound({ messageId: '<root@recvtest.test>' })
    const r = await ingestInbound(
      tenantId,
      inbound({ inReplyTo: '<unknown@elsewhere.test>', references: ['<root@recvtest.test>', '<mid@x.test>'] }),
      NOW
    )
    expect(r.ok).toBe(true)
    if (isReply(r)) expect(r.actions[0]).toContain('References')
  })

  it('falls back to the sender address when no header matches', async () => {
    await outbound()
    const r = await ingestInbound(tenantId, inbound(), NOW)
    expect(r.ok).toBe(true)
    if (isReply(r)) expect(r.contactId).toBe(contactId)
  })

  it('prefers the outbound whose subject matches the thread', async () => {
    await outbound({ subject: 'Different topic', sentAt: new Date(NOW.getTime() - 3600_000) })
    const target = await outbound({ subject: 'Quick question', sentAt: new Date(NOW.getTime() - 7200_000) })

    const r = await ingestInbound(tenantId, inbound({ subject: 'Re: Quick question' }), NOW)
    expect(r.ok).toBe(true)
    // The newest outbound is "Different topic"; matching by subject must beat
    // matching by recency, or a reply lands on the wrong thread whenever two
    // sequences overlap.
    const parent = await owner.emailMessage.findUniqueOrThrow({ where: { id: target.id } })
    expect(parent.repliedAt).not.toBeNull()
  })

  it('stores an unmatched reply rather than dropping it', async () => {
    // A reply we cannot attribute is still a human wanting something. Silently
    // discarding it is how a live deal dies in a shared mailbox.
    const r = await ingestInbound(tenantId, inbound({ fromEmail: 'stranger@nowhere.test' }), NOW)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no_contact')

    const stored = await owner.emailMessage.findFirst({
      where: { tenantId, fromEmail: 'stranger@nowhere.test' },
    })
    expect(stored).not.toBeNull()
    expect(stored?.contactId).toBeNull()
  })

  it.each([
    ['Re: Quick question', 'quick question'],
    ['RE: RE: Quick question', 'quick question'],
    ['Fwd: Re: Quick question', 'quick question'],
    ['AW: Quick question', 'quick question'],
    ['RE[2]: Quick question', 'quick question'],
  ])('normalises %s', (subject, expected) => {
    expect(normalizeSubject(subject)).toBe(expected)
  })
})

describe('idempotency', () => {
  it('ignores the same message twice', async () => {
    // An IMAP poller that crashes mid-batch re-reads the folder; SNS retries on
    // its own schedule. Neither may stop a sequence twice or file two tasks.
    await outbound()
    const e = await enroll(new Date(NOW.getTime() + 86_400_000))
    const msg = inbound()

    const first = await ingestInbound(tenantId, msg, NOW)
    const second = await ingestInbound(tenantId, msg, NOW)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('duplicate')

    expect(await owner.emailMessage.count({ where: { tenantId, direction: 'inbound' } })).toBe(1)
    expect(await owner.task.count({ where: { tenantId } })).toBe(1)
    const enrollment = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(enrollment.status).toBe('stopped_replied')
  })
})

describe('what a reply does to the sequence', () => {
  it('stops an active enrollment when a person replies', async () => {
    await outbound()
    const e = await enroll(new Date(NOW.getTime() + 86_400_000))

    await ingestInbound(tenantId, inbound({ bodyText: 'Yes, keen — send pricing.' }), NOW)

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(after.status).toBe('stopped_replied')
    expect(after.nextRunAt).toBeNull()
  })

  it('does NOT stop on an out-of-office, and holds it until they return', async () => {
    // The reason this whole module exists. Stopping here loses the prospect
    // because they went on holiday; not holding means emailing an empty desk.
    await outbound()
    const e = await enroll(new Date(NOW.getTime() + 86_400_000))

    const r = await ingestInbound(
      tenantId,
      inbound({
        subject: 'Automatic reply: Quick question',
        bodyText: 'I am out of the office until 14 August, with limited access to email.',
        headers: { 'auto-submitted': 'auto-replied' },
      }),
      NOW
    )

    expect(r.ok).toBe(true)
    if (isReply(r)) expect(r.classification.intent).toBe('out_of_office')

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(after.status).toBe('active')
    expect(after.nextRunAt?.toISOString().slice(0, 10)).toBe('2026-08-14')
  })

  it('never pulls a send earlier than it was already scheduled', async () => {
    // An out-of-office saying "back tomorrow" must not drag a step that was due
    // next month forward to tomorrow.
    await outbound()
    const far = new Date('2026-09-30T09:00:00Z')
    const e = await enroll(far)

    await ingestInbound(
      tenantId,
      inbound({
        subject: 'Automatic reply',
        bodyText: 'Out of the office, back on 14 August.',
        headers: { 'auto-submitted': 'auto-replied' },
      }),
      NOW
    )

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(after.nextRunAt?.toISOString()).toBe(far.toISOString())
  })

  it('leaves the sequence running for an out-of-office with no stated return date', async () => {
    await outbound()
    const due = new Date(NOW.getTime() + 86_400_000)
    const e = await enroll(due)

    await ingestInbound(
      tenantId,
      inbound({ subject: 'Automatic reply', bodyText: 'I am away from my desk.', headers: { 'auto-submitted': 'auto-replied' } }),
      NOW
    )

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(after.status).toBe('active')
    expect(after.nextRunAt?.toISOString()).toBe(due.toISOString())
  })
})

describe('opt-out', () => {
  it('suppresses the address and marks do-not-contact', async () => {
    await outbound()
    const e = await enroll(new Date(NOW.getTime() + 86_400_000))

    await ingestInbound(tenantId, inbound({ bodyText: 'Please take me off your list.' }), NOW)

    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('do_not_contact')
    expect(contact.unsubscribedAt).not.toBeNull()

    const suppression = await owner.suppressionEntry.findFirst({
      where: { tenantId, value: 'buyer@prospect.test' },
    })
    expect(suppression).not.toBeNull()

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(after.status).toBe('stopped_unsubscribed')
  })

  it('suppresses even when the message is also an out-of-office', async () => {
    // "I'm away — and remove me" must suppress. Treating it as an absence notice
    // would keep them on the list, which is a legal problem, not a lost deal.
    await outbound()
    await ingestInbound(
      tenantId,
      inbound({
        subject: 'Automatic reply: Quick question',
        bodyText: 'I am out of the office until 14 August. Please unsubscribe me.',
        headers: { 'auto-submitted': 'auto-replied' },
      }),
      NOW
    )

    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.unsubscribedAt).not.toBeNull()
  })
})

describe('tasks and contact state', () => {
  it('files an urgent task for an interested reply', async () => {
    await outbound()
    await ingestInbound(tenantId, inbound({ bodyText: 'Interested — what does it cost?' }), NOW)

    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })
    expect(task.title).toContain('Interested')
    expect(task.assigneeId).toBe(userId)
    expect(task.priority).toBe(3)

    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('engaged')
  })

  it('files no task for a decline, but marks them unqualified', async () => {
    // Nothing for a human to do. A task here would only ever be closed unread,
    // and a task list nobody trusts is worse than none.
    await outbound()
    await ingestInbound(tenantId, inbound({ bodyText: 'Not interested, thanks.' }), NOW)

    expect(await owner.task.count({ where: { tenantId } })).toBe(0)
    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('unqualified')
    expect(contact.lastRepliedAt).not.toBeNull()
  })

  it('files no task for an out-of-office', async () => {
    await outbound()
    await ingestInbound(
      tenantId,
      inbound({ subject: 'Automatic reply', bodyText: 'Out of office until 14 August.', headers: { 'auto-submitted': 'auto-replied' } }),
      NOW
    )
    expect(await owner.task.count({ where: { tenantId } })).toBe(0)
  })

  it('does not mark a contact engaged on an automated reply', async () => {
    await outbound()
    await ingestInbound(
      tenantId,
      inbound({ subject: 'Automatic reply', bodyText: 'Out of office.', headers: { 'auto-submitted': 'auto-replied' } }),
      NOW
    )
    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('new')
    expect(contact.lastRepliedAt).toBeNull()
  })

  it('files a task for a reply it could not read confidently', async () => {
    await outbound()
    const r = await ingestInbound(tenantId, inbound({ bodyText: 'hmm' }), NOW)
    expect(r.ok).toBe(true)
    if (isReply(r)) expect(r.classification.needsReview).toBe(true)

    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })
    expect(task.title).toContain('needs a read')
  })

  it('records why it decided what it decided', async () => {
    // The classifier is heuristic, so every call it makes has to be auditable by
    // the person who has to live with it.
    await outbound()
    await ingestInbound(tenantId, inbound({ bodyText: 'Not interested.' }), NOW)

    const activity = await owner.activity.findFirstOrThrow({ where: { tenantId, type: 'reply' } })
    const detail = activity.detail as { intent: string; reasons: string[]; confidence: number }
    expect(detail.intent).toBe('not_interested')
    expect(detail.reasons.length).toBeGreaterThan(0)
    expect(detail.confidence).toBeGreaterThan(0)
  })

  it('marks a bounce-back on the contact', async () => {
    await outbound()
    await ingestInbound(
      tenantId,
      inbound({
        subject: 'Undeliverable: Quick question',
        bodyText: 'Your message could not be delivered.',
        headers: { 'content-type': 'multipart/report; report-type=delivery-status' },
      }),
      NOW
    )
    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.bouncedAt).not.toBeNull()
  })
})

describe('tenant routing', () => {
  it('resolves the tenant from the address the mail was sent to', async () => {
    expect(await tenantForInbound('rep@recvtest.test')).toBe(tenantId)
    expect(await tenantForInbound('REP@RecvTest.test')).toBe(tenantId)
  })

  it('returns null for an address no tenant owns', async () => {
    expect(await tenantForInbound('nobody@unknown-domain.test')).toBeNull()
  })
})
