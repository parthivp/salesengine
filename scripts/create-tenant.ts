import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { prismaAdmin, disconnect } from '../src/lib/db'
import { hashPassword, validatePassword } from '../src/lib/password'
import { normalizeEmail } from '../src/lib/utils'

/**
 * Creates a real workspace and its first owner.
 *
 * `db:seed` builds demo tenants with `.test` addresses, which is right for
 * looking around and wrong for actually using the product — after deploying there
 * was no way to create a workspace with your own email. Self-serve signup is
 * deliberately not built (this is internal-first), so this is the path in.
 *
 * Non-interactive when the values are supplied as environment variables, so it
 * works in a container where there is no TTY:
 *
 *   TENANT_NAME="Acme" TENANT_SLUG=acme OWNER_EMAIL=me@acme.com \
 *   OWNER_NAME="Me" OWNER_PASSWORD='...' npm run tenant:create
 */

const PLATFORM_ADMIN = process.env.PLATFORM_ADMIN !== 'false'

async function ask(
  rl: ReturnType<typeof createInterface> | null,
  envVar: string,
  question: string,
  fallback?: string
): Promise<string> {
  const fromEnv = process.env[envVar]
  if (fromEnv) return fromEnv
  if (!rl) throw new Error(`${envVar} must be set when running without a terminal.`)
  const answer = (await rl.question(question)).trim()
  return answer || fallback || ''
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

async function main() {
  // Only open a prompt when there is a terminal to prompt on.
  const rl = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null

  try {
    const name = await ask(rl, 'TENANT_NAME', 'Workspace name: ')
    if (!name) throw new Error('A workspace name is required.')

    const slug = slugify(await ask(rl, 'TENANT_SLUG', `Identifier [${slugify(name)}]: `, slugify(name)))
    if (!slug) throw new Error('A workspace identifier is required.')

    const ownerName = await ask(rl, 'OWNER_NAME', 'Your name: ')
    if (!ownerName) throw new Error('Your name is required.')

    const email = normalizeEmail(await ask(rl, 'OWNER_EMAIL', 'Your email: '))
    if (!email) throw new Error('A valid email address is required.')

    const password = await ask(rl, 'OWNER_PASSWORD', 'Choose a password (min 10 chars): ')
    const problem = validatePassword(password)
    if (problem) throw new Error(problem)

    const existingTenant = await prismaAdmin.tenant.findUnique({ where: { slug } })
    if (existingTenant) throw new Error(`A workspace with the identifier "${slug}" already exists.`)

    const passwordHash = await hashPassword(password)

    // One transaction: a workspace with no owner cannot be administered by
    // anyone, so it must never exist even briefly.
    const result = await prismaAdmin.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { slug, name, plan: 'internal', status: 'active' },
      })

      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name: ownerName,
          role: 'owner',
          status: 'active',
          passwordHash,
          // The first account on a fresh deployment operates the deployment.
          // Later workspaces are created by that person, and are not platform
          // admins unless PLATFORM_ADMIN is set explicitly.
          isPlatformAdmin: PLATFORM_ADMIN && (await tx.user.count()) === 0,
        },
      })

      // A pipeline with no stages renders an empty board and gives no hint that
      // stages are the missing thing, so a new workspace gets a default set.
      await tx.pipelineStage.createMany({
        data: [
          { tenantId: tenant.id, name: 'Discovery', order: 1, probability: 10 },
          { tenantId: tenant.id, name: 'Qualified', order: 2, probability: 25 },
          { tenantId: tenant.id, name: 'Proposal', order: 3, probability: 50 },
          { tenantId: tenant.id, name: 'Negotiation', order: 4, probability: 75 },
          { tenantId: tenant.id, name: 'Won', order: 5, probability: 100, isWon: true },
          { tenantId: tenant.id, name: 'Lost', order: 6, probability: 0, isLost: true },
        ],
      })

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorId: owner.id,
          action: 'create',
          entity: 'Tenant',
          entityId: tenant.id,
          after: { slug, name, via: 'create-tenant script' },
        },
      })

      return { tenant, owner }
    })

    console.log(`\n✓ Workspace "${result.tenant.name}" created (${result.tenant.slug}).`)
    console.log(`✓ Owner: ${result.owner.email}`)
    if (result.owner.isPlatformAdmin) {
      console.log('✓ This account is the platform admin for this deployment.')
    }
    console.log('\nSign in at the address in APP_URL. Then:')
    console.log('  1. Add a mailbox           → Admin → Mailboxes')
    console.log('  2. Turn on reply polling   → the same page, "Set up"')
    console.log('  3. Check what is missing   → Admin → Readiness, or `npm run check`')
  } finally {
    rl?.close()
  }
}

main()
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
  .finally(() => disconnect())
