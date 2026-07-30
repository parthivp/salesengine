import 'dotenv/config'
import { prismaAdmin, withTenant, db, disconnect } from '../src/lib/db'
import { rescoreContact } from '../src/lib/leads/scoring'

/** Recomputes every contact's score for a tenant. Use after changing scoring rules. */
async function main() {
  const slug = process.argv[2] ?? 'acme'
  const t = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug } })

  await withTenant(
    t.id,
    async () => {
      const contacts = await db().contact.findMany({ select: { id: true } })
      for (const c of contacts) await rescoreContact(c.id)
      console.log(`Rescored ${contacts.length} contacts in ${slug}`)
    },
    { timeout: 300_000 }
  )

  const rows = await prismaAdmin.contact.findMany({
    where: { tenantId: t.id },
    select: { title: true, score: true },
    orderBy: { score: 'desc' },
  })
  console.log(rows.map((r) => `${String(r.score).padStart(3)}  ${r.title}`).join('\n'))
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  // Closes both the runtime and owner clients; closing only one leaves the
  // process alive with an open pool and the script appears to hang.
  .finally(() => disconnect())
