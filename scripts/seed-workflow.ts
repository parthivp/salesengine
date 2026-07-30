import 'dotenv/config'
import { prismaAdmin, withTenant, db, tid, disconnect } from '../src/lib/db'
import { ensureDefaultStages } from '../src/lib/workflow/pipeline'

/**
 * Phase 5 demo data: deals across the pipeline (including deliberately stalled
 * ones so rot detection is visible), plus a spread of tasks.
 */
async function main() {
  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  const rep = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'rohan@acme.test' },
  })
  const manager = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'maya@acme.test' },
  })

  await withTenant(tenant.id, async () => {
    const stages = await ensureDefaultStages()
    const stage = (n: string) => stages.find((s) => s.name === n)!

    const contacts = await db().contact.findMany({
      where: { email: { not: null } },
      include: { account: true },
      orderBy: { score: 'desc' },
      take: 10,
    })
    if (!contacts.length) {
      console.log('No contacts — run `npm run db:seed-demo` first.')
      return
    }

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

    const plan: {
      stage: string; value: number; owner: string; lastActivityDaysAgo: number; closeInDays: number
    }[] = [
      { stage: 'Prospecting', value: 18_000, owner: rep.id, lastActivityDaysAgo: 2, closeInDays: 60 },
      { stage: 'Prospecting', value: 9_500, owner: rep.id, lastActivityDaysAgo: 25, closeInDays: 45 },
      { stage: 'Discovery', value: 42_000, owner: manager.id, lastActivityDaysAgo: 3, closeInDays: 40 },
      { stage: 'Discovery', value: 27_500, owner: rep.id, lastActivityDaysAgo: 16, closeInDays: 30 },
      { stage: 'Proposal', value: 65_000, owner: manager.id, lastActivityDaysAgo: 1, closeInDays: 21 },
      { stage: 'Proposal', value: 31_000, owner: rep.id, lastActivityDaysAgo: 12, closeInDays: 14 },
      // Deliberately past its close date, to show that check firing.
      { stage: 'Negotiation', value: 88_000, owner: manager.id, lastActivityDaysAgo: 4, closeInDays: -6 },
      { stage: 'Negotiation', value: 54_000, owner: rep.id, lastActivityDaysAgo: 2, closeInDays: 10 },
      { stage: 'Closed won', value: 120_000, owner: manager.id, lastActivityDaysAgo: 20, closeInDays: -20 },
      { stage: 'Closed won', value: 46_000, owner: rep.id, lastActivityDaysAgo: 45, closeInDays: -45 },
      { stage: 'Closed lost', value: 22_000, owner: rep.id, lastActivityDaysAgo: 30, closeInDays: -30 },
    ]

    let created = 0
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]
      const contact = contacts[i % contacts.length]
      const name = `${contact.account?.name ?? 'Prospect'} — ${p.stage === 'Closed won' ? 'signed' : 'rollout'}`

      const existing = await db().deal.findFirst({ where: { name, stageId: stage(p.stage).id } })
      if (existing) continue

      const isClosed = p.stage.startsWith('Closed')
      await db().deal.create({
        data: {
          tenantId: tid(),
          name,
          value: p.value,
          stageId: stage(p.stage).id,
          accountId: contact.accountId,
          contactId: contact.id,
          ownerId: p.owner,
          expectedCloseDate: new Date(Date.now() + p.closeInDays * 86_400_000),
          lastActivityAt: daysAgo(p.lastActivityDaysAgo),
          closedAt: isClosed ? daysAgo(Math.abs(p.closeInDays)) : null,
          createdAt: daysAgo(60 + i * 3),
        },
      })
      created++
    }

    // A realistic task spread, including overdue work.
    const taskPlan: { type: 'call' | 'follow_up' | 'meeting' | 'linkedin'; title: string; dueDays: number; priority: number; assignee: string }[] = [
      { type: 'follow_up', title: 'Send pricing to Sofia', dueDays: -3, priority: 3, assignee: rep.id },
      { type: 'call', title: 'Second attempt — Priya Raman', dueDays: -1, priority: 2, assignee: rep.id },
      { type: 'meeting', title: 'Discovery call — Marcus Lund', dueDays: 0, priority: 3, assignee: manager.id },
      { type: 'follow_up', title: 'Chase signed order form', dueDays: 0, priority: 2, assignee: rep.id },
      { type: 'linkedin', title: 'Connect with Clara Nkemdirim', dueDays: 1, priority: 0, assignee: rep.id },
      { type: 'call', title: 'Intro call — Felix Braun', dueDays: 2, priority: 1, assignee: rep.id },
      { type: 'follow_up', title: 'Quarterly check-in — Omar Haddad', dueDays: 5, priority: 0, assignee: manager.id },
    ]

    let tasks = 0
    for (let i = 0; i < taskPlan.length; i++) {
      const t = taskPlan[i]
      const contact = contacts[i % contacts.length]
      const existing = await db().task.findFirst({ where: { title: t.title } })
      if (existing) continue
      await db().task.create({
        data: {
          tenantId: tid(),
          type: t.type,
          title: t.title,
          contactId: contact.id,
          accountId: contact.accountId,
          assigneeId: t.assignee,
          dueAt: new Date(Date.now() + t.dueDays * 86_400_000),
          priority: t.priority,
          ...(t.type === 'linkedin'
            ? {
                payload: {
                  linkedinUrl: contact.linkedinUrl,
                  draft: `Hi ${contact.firstName ?? 'there'}, sent you a note about ${
                    contact.account?.name ?? 'your team'
                  } handoffs. Worth connecting either way.`,
                  stepType: 'linkedin_connect',
                },
              }
            : {}),
        },
      })
      tasks++
    }

    // Some completed history so "done today" and the leaderboard are not all zero.
    for (const [i, outcome] of ['Connected', 'Meeting booked', 'Held', 'Done'].entries()) {
      const contact = contacts[i % contacts.length]
      const title = `Completed: ${outcome} #${i + 1}`
      const existing = await db().task.findFirst({ where: { title } })
      if (existing) continue
      await db().task.create({
        data: {
          tenantId: tid(),
          type: outcome === 'Held' ? 'meeting' : 'call',
          title,
          contactId: contact.id,
          assigneeId: i % 2 === 0 ? rep.id : manager.id,
          status: 'completed',
          outcome,
          completedAt: new Date(Date.now() - i * 3_600_000),
          dueAt: new Date(Date.now() - i * 3_600_000),
        },
      })
    }

    console.log(`Created ${created} deals and ${tasks} open tasks`)
  }, { timeout: 180_000 })

  const [deals, openTasks] = await Promise.all([
    prismaAdmin.deal.count({ where: { tenantId: tenant.id } }),
    prismaAdmin.task.count({ where: { tenantId: tenant.id, status: 'open' } }),
  ])
  console.log(`Totals: ${deals} deals, ${openTasks} open tasks`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => disconnect())
