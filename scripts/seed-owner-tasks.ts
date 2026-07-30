import 'dotenv/config'
import { prismaAdmin, withTenant, db, tid, disconnect } from '../src/lib/db'

/** Assigns a few tasks to the owner account so the queue view is demonstrable. */
async function main() {
  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  const owner = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'parthiv@acme.test' },
  })

  await withTenant(tenant.id, async () => {
    const contacts = await db().contact.findMany({
      where: { email: { not: null } },
      include: { account: true },
      orderBy: { score: 'desc' },
      take: 5,
    })

    // Each task names the contact it is about, so link the row to *that* person
    // rather than to whatever is next in the list — a task titled "Call Felix"
    // pointing at Daniel Okafor reads as a bug even when it is only seed data.
    const plan = [
      { type: 'follow_up' as const, who: 'Sofia', title: 'Reply from Sofia Marchetti — send pricing', dueDays: -2, priority: 3 },
      { type: 'call' as const, who: 'Felix', title: 'Call Felix Braun about the OrbitalCast rollout', dueDays: -1, priority: 2 },
      { type: 'meeting' as const, who: 'Marcus', title: 'Discovery call — Marcus Lund at ArborGrid', dueDays: 0, priority: 2 },
      { type: 'linkedin' as const, who: 'Clara', title: 'Connect with Clara Nkemdirim', dueDays: 0, priority: 1 },
      { type: 'follow_up' as const, who: 'Omar', title: 'Check in with Omar Haddad next quarter', dueDays: 6, priority: 0 },
    ]

    const byName = async (first: string) =>
      db().contact.findFirst({
        where: { firstName: { equals: first, mode: 'insensitive' } },
        include: { account: true },
      })

    let n = 0
    for (let i = 0; i < plan.length; i++) {
      const t = plan[i]
      const contact = (await byName(t.who)) ?? contacts[i % Math.max(1, contacts.length)]
      const existing = await db().task.findFirst({ where: { title: t.title } })
      if (existing) continue
      await db().task.create({
        data: {
          tenantId: tid(),
          type: t.type,
          title: t.title,
          contactId: contact?.id,
          accountId: contact?.accountId,
          assigneeId: owner.id,
          dueAt: new Date(Date.now() + t.dueDays * 86_400_000),
          priority: t.priority,
          note: t.type === 'follow_up' && t.priority === 3
            ? 'They asked for pricing and a reference in the same industry.'
            : null,
          ...(t.type === 'linkedin'
            ? {
                payload: {
                  linkedinUrl: contact?.linkedinUrl ?? 'https://linkedin.com/in/example',
                  draft: `Hi ${contact?.firstName ?? 'there'}, sent you a note about ${
                    contact?.account?.name ?? 'your team'
                  } handoffs. Worth connecting either way.`,
                  stepType: 'linkedin_connect',
                },
              }
            : {}),
        },
      })
      n++
    }
    console.log(`Assigned ${n} tasks to the owner`)
  }, { timeout: 60_000 })
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => disconnect())
