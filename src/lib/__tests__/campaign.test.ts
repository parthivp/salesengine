import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant } from '../db'
import { processEnrollmentStep, releaseHumanStep, timeOutAbandonedSteps } from '../../worker/jobs/sequence'
import { campaignFunnel } from '../sequences/funnel'
import { recordAction } from '../linkedin/queue'

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
let userId: string

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'campaign-test' },
    update: {},
    create: { slug: 'campaign-test', name: 'Campaign Test Co' },
  })
  tenantId = t.id
  const u = await owner.user.upsert({
    where: { tenantId_email: { tenantId, email: 'rep@campaign.test' } },
    update: {},
    create: { tenantId, email: 'rep@campaign.test', name: 'Rep', role: 'rep', status: 'active' },
  })
  userId = u.id
})

beforeEach(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.sequenceStep.deleteMany({ where: { sequence: { tenantId } } })
  await owner.sequence.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
})

afterAll(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.sequenceStep.deleteMany({ where: { sequence: { tenantId } } })
  await owner.sequence.deleteMany({ where: { tenantId } })
  await owner.contact.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

/** connect → (conditional) message. The canonical LinkedIn campaign. */
async function campaign(secondStepCondition: Record<string, unknown> = {}) {
  const seq = await owner.sequence.create({
    data: { tenantId, name: 'LI campaign', status: 'active', createdById: userId },
  })
  await owner.sequenceStep.create({
    data: { sequenceId: seq.id, order: 0, type: 'linkedin_connect', bodyText: 'Hi {{first_name}}' },
  })
  await owner.sequenceStep.create({
    data: {
      sequenceId: seq.id, order: 1, type: 'linkedin_message',
      bodyText: 'Following up', conditions: secondStepCondition as never,
    },
  })
  return seq
}

async function enrol(seqId: string, over: Record<string, unknown> = {}) {
  const contact = await owner.contact.create({
    data: {
      tenantId, firstName: 'Borong', lastName: 'Liu',
      linkedinUrl: 'https://linkedin.com/in/borongliu', ownerId: userId, ...over,
    },
  })
  const e = await owner.sequenceEnrollment.create({
    data: {
      tenantId, sequenceId: seqId, contactId: contact.id,
      status: 'active', nextRunAt: new Date(), stepIndex: 0,
    },
  })
  return { contact, enrollment: e }
}

describe('a LinkedIn step waits for the human', () => {
  it('parks the enrollment instead of racing ahead', async () => {
    // The bug this replaces: the engine created the card and advanced in the same
    // breath, so the follow-up message was queued whether or not the connection
    // request had been sent, let alone accepted.
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)

    const r = await withTenant(tenantId, () =>
      processEnrollmentStep({ enrollmentId: enrollment.id, tenantId })
    )
    expect('kind' in r && r.kind).toBe('waiting')

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(after.status).toBe('waiting_on_human')
    expect(after.nextRunAt).toBeNull()
    expect(after.waitingUntil).not.toBeNull()
    expect(after.stepIndex).toBe(0) // has NOT moved on

    const tasks = await owner.task.findMany({ where: { tenantId } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].enrollmentId).toBe(enrollment.id)
  })

  it('names the card after the person, not a null email address', async () => {
    // These contacts have no email — that is the whole reason the LinkedIn path
    // exists — and the title used to render "linkedin connect — null".
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })
    expect(task.title).toContain('Borong Liu')
    expect(task.title).not.toMatch(/null|undefined/)
  })

  it('moves on once the rep records the send', async () => {
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })

    await withTenant(tenantId, () =>
      recordAction({ taskId: task.id, actorId: userId, outcome: 'sent' })
    )

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(after.status).toBe('active')
    expect(after.waitingUntil).toBeNull()
    expect(after.stepIndex).toBe(1)
  })

  it('ends the campaign when the rep says not a fit', async () => {
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })

    await withTenant(tenantId, () =>
      recordAction({ taskId: task.id, actorId: userId, outcome: 'not_a_fit' })
    )

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(after.status).toBe('stopped_manual')
  })

  it('gives up on a card nobody ever touches', async () => {
    // An enrollment parked forever reads as "in progress" on the dashboard while
    // doing nothing, which is the invisible failure mode this engine keeps trying
    // to design out.
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))

    await owner.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { waitingUntil: new Date(Date.now() - 1000) },
    })
    const r = await withTenant(tenantId, () => timeOutAbandonedSteps())
    expect(r.timedOut).toBe(1)

    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    // Advanced, not stopped: the step was skipped, the prospect is still live.
    expect(after.stepIndex).toBe(1)
    expect(after.status).not.toBe('waiting_on_human')
  })

  it('does not release an enrollment that was never waiting', async () => {
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)
    const r = await withTenant(tenantId, () => releaseHumanStep(enrollment.id, 'done'))
    expect(r.released).toBe(false)
  })
})

describe('branching on acceptance', () => {
  async function runToSecondStep(connectedAt: Date | null) {
    const seq = await campaign({ type: 'if_connected' })
    const { contact, enrollment } = await enrol(seq.id, { linkedinConnectedAt: connectedAt })
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })
    await withTenant(tenantId, () => recordAction({ taskId: task.id, actorId: userId, outcome: 'sent' }))
    // Now on step 2; run it and see whether the condition let it through.
    await owner.sequenceEnrollment.update({
      where: { id: enrollment.id }, data: { nextRunAt: new Date() },
    })
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    return { contact, enrollment }
  }

  it('messages someone who accepted', async () => {
    const { enrollment } = await runToSecondStep(new Date())
    const tasks = await owner.task.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } })
    expect(tasks).toHaveLength(2) // the connect card, then the message card
    const after = await owner.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(after.status).toBe('waiting_on_human')
  })

  it('skips someone who has not accepted', async () => {
    await runToSecondStep(null)
    const tasks = await owner.task.findMany({ where: { tenantId } })
    expect(tasks).toHaveLength(1) // only the connect card
  })

  it('if_not_connected is the mirror image', async () => {
    const seq = await campaign({ type: 'if_not_connected' })
    const { enrollment } = await enrol(seq.id, { linkedinConnectedAt: new Date() })
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    const task = await owner.task.findFirstOrThrow({ where: { tenantId } })
    await withTenant(tenantId, () => recordAction({ taskId: task.id, actorId: userId, outcome: 'sent' }))
    await owner.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { nextRunAt: new Date() } })
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    expect(await owner.task.count({ where: { tenantId } })).toBe(1)
  })
})

describe('the campaign funnel', () => {
  it('counts each stage from a recorded fact, not the step index', async () => {
    const seq = await campaign()
    const now = new Date()
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000)

    // 4 enrolled, 3 invited, 2 accepted, 1 replied.
    const people = [
      { linkedinInvitedAt: days(10), linkedinConnectedAt: days(8), lastRepliedAt: days(2) },
      { linkedinInvitedAt: days(10), linkedinConnectedAt: days(6) },
      { linkedinInvitedAt: days(10) },
      {},
    ]
    for (const [i, p] of people.entries()) {
      const c = await owner.contact.create({
        data: { tenantId, firstName: `P${i}`, linkedinUrl: `https://linkedin.com/in/p${i}`, ...p },
      })
      await owner.sequenceEnrollment.create({
        data: { tenantId, sequenceId: seq.id, contactId: c.id, status: 'active' },
      })
    }

    const f = await withTenant(tenantId, () => campaignFunnel(seq.id))
    expect(f.stages.map((s) => s.count)).toEqual([4, 3, 2, 1])
    expect(f.stages[2].ofPrevious).toBeCloseTo(2 / 3)
    expect(f.medianDaysToAccept).toBe(3) // gaps of 2 and 4
  })

  it('ignores a negative gap rather than reporting a nonsense median', async () => {
    // Someone marked "already connected" was connected before the campaign
    // invited them. Counting that would drag the median below zero.
    const seq = await campaign()
    const now = Date.now()
    const c = await owner.contact.create({
      data: {
        tenantId, firstName: 'Backwards', linkedinUrl: 'https://linkedin.com/in/backwards',
        linkedinInvitedAt: new Date(now), linkedinConnectedAt: new Date(now - 5 * 86_400_000),
      },
    })
    await owner.sequenceEnrollment.create({
      data: { tenantId, sequenceId: seq.id, contactId: c.id, status: 'active' },
    })
    const f = await withTenant(tenantId, () => campaignFunnel(seq.id))
    expect(f.medianDaysToAccept).toBeNull()
  })

  it('reports how many are parked waiting on the operator', async () => {
    const seq = await campaign()
    const { enrollment } = await enrol(seq.id)
    await withTenant(tenantId, () => processEnrollmentStep({ enrollmentId: enrollment.id, tenantId }))
    const f = await withTenant(tenantId, () => campaignFunnel(seq.id))
    expect(f.waitingOnYou).toBe(1)
  })
})
