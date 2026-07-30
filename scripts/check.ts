import 'dotenv/config'
import { prismaAdmin, disconnect } from '../src/lib/db'
import { assess, type Severity } from '../src/lib/readiness'
import { closeQueues } from '../src/lib/queue'

/**
 * `npm run check` — is this deployment ready to run a real pipeline?
 *
 * Exits non-zero when there is a blocker, so it works as a post-deploy gate as
 * well as something to run by hand.
 */

const ICON: Record<Severity, string> = { blocker: '✗', warning: '!', info: '·', ok: '✓' }

async function main() {
  const slug = process.argv[2]
  const tenant = slug
    ? await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug } })
    : await prismaAdmin.tenant.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })

  const result = await assess(tenant.id)

  console.log(`\nSalesEngine readiness — ${tenant.name} (${tenant.slug})`)

  let area = ''
  for (const c of result.checks) {
    if (c.area !== area) {
      area = c.area
      console.log(`\n  ${area}`)
    }
    console.log(`    ${ICON[c.severity]} ${c.label}: ${c.detail}`)
    if (c.fix) console.log(`        → ${c.fix}`)
  }

  console.log(
    `\n${result.ready ? 'READY' : 'NOT READY'} — ` +
      `${result.blockers} blocker(s), ${result.warnings} warning(s)\n`
  )

  if (!result.ready) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeQueues()
    await disconnect()
  })
