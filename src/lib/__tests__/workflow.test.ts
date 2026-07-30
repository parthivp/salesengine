import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { withTenant, db } from '../db'
import {
  bucketFor, queueWeight, completeTask, snoozeTask, skipTask, wakeSnoozedTasks,
} from '../workflow/tasks'
import {
  assessDeal, computeForecast, moveDeal, ensureDefaultStages, rotDaysFor,
} from '../workflow/pipeline'
import { rate, MIN_DENOMINATOR } from '../workflow/reports'
import type { Deal, PipelineStage, Task } from '@prisma/client'

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

let tenantId: string
let userId: string
let contactId: string
let accountId: string
let stages: PipelineStage[]

beforeAll(async () => {
  const t = await owner.tenant.upsert({
    where: { slug: 'workflow-test' },
    update: {},
    create: { slug: 'workflow-test', name: 'Workflow Test Co' },
  })
  tenantId = t.id

  const user = await owner.user.upsert({
    where: { tenantId_email: { tenantId, email: 'rep@wf.test' } },
    update: {},
    create: { tenantId, email: 'rep@wf.test', name: 'WF Rep', role: 'rep', status: 'active' },
  })
  userId = user.id

  const account = await owner.account.upsert({
    where: { tenantId_domain: { tenantId, domain: 'wf.test' } },
    update: {},
    create: { tenantId, name: 'WF Client', domain: 'wf.test' },
  })
  accountId = account.id

  const contact = await owner.contact.upsert({
    where: { tenantId_email: { tenantId, email: 'buyer@wf.test' } },
    update: {},
    create: { tenantId, email: 'buyer@wf.test', firstName: 'Bea', accountId, ownerId: userId },
  })
  contactId = contact.id

  stages = await withTenant(tenantId, () => ensureDefaultStages())
})

beforeEach(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.deal.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await owner.contact.update({ where: { id: contactId }, data: { status: 'new' } })
})

afterAll(async () => {
  await owner.task.deleteMany({ where: { tenantId } })
  await owner.deal.deleteMany({ where: { tenantId } })
  await owner.activity.deleteMany({ where: { tenantId } })
  await owner.$disconnect()
})

const stageBy = (name: string) => stages.find((s) => s.name === name)!

// ===========================================================================

describe('task queue ordering', () => {
  const t = (over: Partial<Task>): Task =>
    ({ priority: 0, type: 'other', dueAt: null, snoozedTo: null, status: 'open', ...over }) as Task

  const now = new Date('2026-07-30T12:00:00Z')

  it('buckets by due date relative to now', () => {
    expect(bucketFor(t({ dueAt: new Date('2026-07-29T12:00:00Z') }), now)).toBe('overdue')
    expect(bucketFor(t({ dueAt: new Date('2026-07-30T18:00:00Z') }), now)).toBe('today')
    expect(bucketFor(t({ dueAt: new Date('2026-08-02T09:00:00Z') }), now)).toBe('upcoming')
    expect(bucketFor(t({ dueAt: null }), now)).toBe('upcoming')
  })

  it('treats a future snooze as its own bucket, not as due work', () => {
    expect(
      bucketFor(
        t({ status: 'snoozed', snoozedTo: new Date('2026-08-05T09:00:00Z'), dueAt: new Date('2026-07-29T09:00:00Z') }),
        now
      )
    ).toBe('snoozed')
  })

  it('puts a high-priority reply above an older low-priority task', () => {
    // This is the ordering bug worth guarding: a queue sorted only by due date
    // buries a CRO asking for pricing under a month of cold follow-ups.
    const hotReply = t({ priority: 3, type: 'follow_up', dueAt: now })
    const staleCold = t({ priority: 0, type: 'other', dueAt: new Date('2026-06-01T09:00:00Z') })

    expect(queueWeight(hotReply, now)).toBeLessThan(queueWeight(staleCold, now))
  })

  it('surfaces the older of two equal-priority tasks first', () => {
    const older = t({ priority: 1, dueAt: new Date('2026-07-25T09:00:00Z') })
    const newer = t({ priority: 1, dueAt: new Date('2026-07-29T09:00:00Z') })
    expect(queueWeight(older, now)).toBeLessThan(queueWeight(newer, now))
  })

  it('caps the overdue bonus so ancient tasks cannot outrank urgent ones forever', () => {
    const ancient = t({ priority: 1, dueAt: new Date('2025-01-01T09:00:00Z') })
    const urgentToday = t({ priority: 3, dueAt: now })
    expect(queueWeight(urgentToday, now)).toBeLessThan(queueWeight(ancient, now))
  })

  it('edges follow-ups ahead of generic tasks at equal priority and due date', () => {
    const followUp = t({ priority: 1, type: 'follow_up', dueAt: now })
    const generic = t({ priority: 1, type: 'other', dueAt: now })
    expect(queueWeight(followUp, now)).toBeLessThan(queueWeight(generic, now))
  })
})

describe('task completion', () => {
  async function makeTask(over: Partial<Task> = {}) {
    return withTenant(tenantId, () =>
      db().task.create({
        data: {
          tenantId,
          type: over.type ?? 'call',
          title: over.title ?? 'Call Bea',
          contactId,
          accountId,
          assigneeId: userId,
          dueAt: new Date(),
          priority: over.priority ?? 1,
        },
      })
    )
  }

  it('marks complete and records an activity', async () => {
    const task = await makeTask()
    await withTenant(tenantId, () =>
      completeTask({ taskId: task.id, outcome: 'Connected', actorId: userId })
    )

    const after = await owner.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('completed')
    expect(after.outcome).toBe('Connected')
    expect(after.completedAt).not.toBeNull()

    const acts = await owner.activity.findMany({ where: { tenantId, contactId } })
    expect(acts.some((a) => a.summary.includes('Connected'))).toBe(true)
  })

  it('chains the next action so the rep does not have to remember it', async () => {
    const task = await makeTask({ type: 'call' })
    const r = await withTenant(tenantId, () =>
      completeTask({ taskId: task.id, outcome: 'Voicemail', actorId: userId })
    )
    expect(r.followUpId).toBeTruthy()

    const followUp = await owner.task.findUniqueOrThrow({ where: { id: r.followUpId! } })
    expect(followUp.type).toBe('call')
    expect(followUp.title).toContain('Second call')
    expect(followUp.assigneeId).toBe(userId)
    expect(followUp.dueAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('creates no follow-up when the outcome implies none', async () => {
    const task = await makeTask({ type: 'call' })
    const r = await withTenant(tenantId, () =>
      completeTask({ taskId: task.id, outcome: 'Not interested', actorId: userId })
    )
    expect(r.followUpId).toBeUndefined()
  })

  it('actually stops outreach on a "not interested" outcome', async () => {
    // Closing the task without stopping the sequence is the bug: the prospect
    // said no and keeps receiving email.
    const sequence = await owner.sequence.create({
      data: { tenantId, name: `wf-seq-${Date.now()}`, status: 'active' },
    })
    await owner.sequenceEnrollment.create({
      data: { tenantId, sequenceId: sequence.id, contactId, status: 'active', nextRunAt: new Date() },
    })

    const task = await makeTask({ type: 'call' })
    await withTenant(tenantId, () =>
      completeTask({ taskId: task.id, outcome: 'Not interested', actorId: userId })
    )

    const enrollment = await owner.sequenceEnrollment.findFirstOrThrow({ where: { tenantId, contactId } })
    expect(enrollment.status).toBe('stopped_manual')
    expect(enrollment.nextRunAt).toBeNull()

    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('unqualified')

    await owner.sequenceEnrollment.deleteMany({ where: { tenantId } })
    await owner.sequence.delete({ where: { id: sequence.id } })
  })

  it('marks the contact qualified when a meeting is booked', async () => {
    const task = await makeTask({ type: 'call' })
    const r = await withTenant(tenantId, () =>
      completeTask({ taskId: task.id, outcome: 'Meeting booked', actorId: userId })
    )
    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('qualified')
    const followUp = await owner.task.findUniqueOrThrow({ where: { id: r.followUpId! } })
    expect(followUp.type).toBe('meeting')
  })

  it('snoozes, then wakes when the time comes', async () => {
    const task = await makeTask()
    const past = new Date(Date.now() - 60_000)
    await withTenant(tenantId, () => snoozeTask(task.id, past, 'waiting on procurement'))

    let after = await owner.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('snoozed')

    const woken = await withTenant(tenantId, () => wakeSnoozedTasks())
    expect(woken).toBeGreaterThanOrEqual(1)

    after = await owner.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('open')
    expect(after.snoozedTo).toBeNull()
  })

  it('leaves a still-snoozed task alone', async () => {
    const task = await makeTask()
    const future = new Date(Date.now() + 86_400_000)
    await withTenant(tenantId, () => snoozeTask(task.id, future))
    await withTenant(tenantId, () => wakeSnoozedTasks())
    const after = await owner.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('snoozed')
  })

  it('records a skip with its reason', async () => {
    const task = await makeTask()
    await withTenant(tenantId, () => skipTask(task.id, 'Duplicate of another thread'))
    const after = await owner.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('skipped')
    expect(after.outcome).toContain('Duplicate')
  })
})

describe('deal health', () => {
  const stage = (over: Partial<PipelineStage> = {}) =>
    ({ name: 'Discovery', isWon: false, isLost: false, ...over }) as PipelineStage
  const deal = (over: Partial<Deal> = {}) =>
    ({ lastActivityAt: null, updatedAt: new Date(), expectedCloseDate: null, closedAt: null, ...over }) as Deal

  const now = new Date('2026-07-30T12:00:00Z')
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

  it('uses a per-stage threshold, because silence means different things', () => {
    expect(rotDaysFor('Prospecting')).toBeGreaterThan(rotDaysFor('Negotiation'))
    // Ten days of silence is fine in Prospecting and alarming in Negotiation.
    expect(assessDeal(deal({ lastActivityAt: daysAgo(10) }), stage({ name: 'Prospecting' }), now).status)
      .toBe('fresh')
    expect(assessDeal(deal({ lastActivityAt: daysAgo(10) }), stage({ name: 'Negotiation' }), now).status)
      .toBe('rotting')
  })

  it('warns before it declares a deal rotten', () => {
    expect(assessDeal(deal({ lastActivityAt: daysAgo(9) }), stage({ name: 'Discovery' }), now).status)
      .toBe('watch')
    expect(assessDeal(deal({ lastActivityAt: daysAgo(1) }), stage({ name: 'Discovery' }), now).status)
      .toBe('fresh')
  })

  it('treats a passed close date as rotting regardless of recent activity', () => {
    const health = assessDeal(
      deal({ lastActivityAt: daysAgo(1), expectedCloseDate: daysAgo(5) }),
      stage(),
      now
    )
    expect(health.status).toBe('rotting')
    expect(health.reason).toContain('close date')
  })

  it('never rots a closed deal', () => {
    expect(assessDeal(deal({ lastActivityAt: daysAgo(400) }), stage({ isWon: true }), now).status)
      .toBe('fresh')
    expect(assessDeal(deal({ lastActivityAt: daysAgo(400) }), stage({ isLost: true }), now).status)
      .toBe('fresh')
  })

  it('falls back to updatedAt when there is no recorded activity', () => {
    const health = assessDeal(deal({ lastActivityAt: null, updatedAt: daysAgo(20) }), stage(), now)
    expect(health.status).toBe('rotting')
    expect(health.daysSinceActivity).toBe(20)
  })
})

describe('forecast', () => {
  const d = (value: number, probability: number, opts: { won?: boolean; lost?: boolean; days?: number } = {}) => ({
    value: value as unknown as Deal['value'],
    closedAt: opts.won || opts.lost ? new Date('2026-07-30T00:00:00Z') : null,
    createdAt: new Date(new Date('2026-07-30T00:00:00Z').getTime() - (opts.days ?? 30) * 86_400_000),
    stage: { probability, isWon: Boolean(opts.won), isLost: Boolean(opts.lost) } as PipelineStage,
  })

  it('weights open pipeline by stage probability', () => {
    const f = computeForecast([d(10_000, 25), d(20_000, 50)])
    expect(f.openValue).toBe(30_000)
    expect(f.weightedValue).toBe(2_500 + 10_000)
  })

  it('excludes closed deals from open pipeline', () => {
    const f = computeForecast([d(10_000, 25), d(50_000, 100, { won: true }), d(9_000, 0, { lost: true })])
    expect(f.openCount).toBe(1)
    expect(f.openValue).toBe(10_000)
    expect(f.wonValue).toBe(50_000)
    expect(f.lostValue).toBe(9_000)
  })

  it('computes win rate over closed deals only', () => {
    const f = computeForecast([
      d(1, 100, { won: true }), d(1, 100, { won: true }),
      d(1, 0, { lost: true }), d(1, 25), d(1, 25), d(1, 25),
    ])
    // 2 won of 3 closed = 66.7%, not 2 of 6.
    expect(f.winRate).toBeCloseTo(66.67, 1)
  })

  it('returns null rather than 0% when nothing has closed', () => {
    const f = computeForecast([d(5_000, 25)])
    expect(f.winRate).toBeNull()
    expect(f.avgDealSize).toBeNull()
    expect(f.avgSalesCycleDays).toBeNull()
  })

  it('averages the sales cycle over won deals', () => {
    const f = computeForecast([d(1, 100, { won: true, days: 20 }), d(1, 100, { won: true, days: 40 })])
    expect(f.avgSalesCycleDays).toBe(30)
  })

  it('handles an empty pipeline without dividing by zero', () => {
    const f = computeForecast([])
    expect(f).toMatchObject({ openCount: 0, openValue: 0, weightedValue: 0, winRate: null })
  })
})

describe('moving deals', () => {
  async function makeDeal(stageName = 'Discovery') {
    return withTenant(tenantId, () =>
      db().deal.create({
        data: {
          tenantId,
          name: 'WF Deal',
          value: 25_000,
          stageId: stageBy(stageName).id,
          accountId,
          contactId,
          ownerId: userId,
        },
      })
    )
  }

  it('records a stage change on the timeline', async () => {
    const deal = await makeDeal()
    await withTenant(tenantId, () =>
      moveDeal({ dealId: deal.id, toStageId: stageBy('Proposal').id, actorId: userId })
    )

    const acts = await owner.activity.findMany({ where: { tenantId, type: 'stage_change' } })
    expect(acts).toHaveLength(1)
    expect(acts[0].summary).toContain('Discovery → Proposal')
  })

  it('is a no-op when the stage has not changed', async () => {
    const deal = await makeDeal()
    await withTenant(tenantId, () =>
      moveDeal({ dealId: deal.id, toStageId: stageBy('Discovery').id, actorId: userId })
    )
    expect(await owner.activity.count({ where: { tenantId, type: 'stage_change' } })).toBe(0)
  })

  it('closes the deal, marks the contact a customer and clears open tasks on a win', async () => {
    const deal = await makeDeal()
    await withTenant(tenantId, () =>
      db().task.create({
        data: { tenantId, type: 'follow_up', title: 'Chase paperwork', dealId: deal.id, assigneeId: userId },
      })
    )

    await withTenant(tenantId, () =>
      moveDeal({ dealId: deal.id, toStageId: stageBy('Closed won').id, actorId: userId })
    )

    const after = await owner.deal.findUniqueOrThrow({ where: { id: deal.id } })
    expect(after.closedAt).not.toBeNull()

    const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    expect(contact.status).toBe('customer')

    const task = await owner.task.findFirstOrThrow({ where: { tenantId, dealId: deal.id } })
    expect(task.status).toBe('skipped')
  })

  it('reopens closedAt when a deal moves back out of a closed stage', async () => {
    const deal = await makeDeal()
    await withTenant(tenantId, () =>
      moveDeal({ dealId: deal.id, toStageId: stageBy('Closed lost').id, actorId: userId })
    )
    expect((await owner.deal.findUniqueOrThrow({ where: { id: deal.id } })).closedAt).not.toBeNull()

    await withTenant(tenantId, () =>
      moveDeal({ dealId: deal.id, toStageId: stageBy('Negotiation').id, actorId: userId })
    )
    expect((await owner.deal.findUniqueOrThrow({ where: { id: deal.id } })).closedAt).toBeNull()
  })
})

describe('report rates', () => {
  it('suppresses a rate whose denominator is too small to mean anything', () => {
    // 1 reply from 3 sends is not a 33% performer.
    expect(rate(1, 3)).toBeNull()
    expect(rate(1, MIN_DENOMINATOR - 1)).toBeNull()
  })

  it('reports a rate once the denominator is large enough', () => {
    expect(rate(5, 100)).toBe(5)
    expect(rate(1, MIN_DENOMINATOR)).toBeCloseTo(5, 5)
  })

  it('accepts a custom floor for metrics with different noise profiles', () => {
    expect(rate(1, 3, 1)).toBeCloseTo(33.33, 1)
  })

  it('does not divide by zero', () => {
    expect(rate(0, 0)).toBeNull()
  })
})
