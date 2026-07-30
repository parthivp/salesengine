import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * Seeds two tenants deliberately: one is the working demo, the second exists so
 * the isolation test in src/lib/__tests__ has something real to try to leak.
 * Runs as the owner role (DIRECT_DATABASE_URL) which bypasses RLS.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
})

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe12345'

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12)

  // --- Tenant 1: the working demo -----------------------------------------
  const acme = await prisma.tenant.upsert({
    where: { slug: 'acme' },
    update: {},
    create: {
      slug: 'acme',
      name: 'Acme Sales',
      plan: 'internal',
      seatLimit: 25,
      monthlyEmailLimit: 100_000,
    },
  })

  const owner = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: acme.id, email: 'parthiv@acme.test' } },
    update: {},
    create: {
      tenantId: acme.id,
      email: 'parthiv@acme.test',
      name: 'Parthiv',
      role: 'owner',
      status: 'active',
      passwordHash,
      isPlatformAdmin: true,
    },
  })

  const emea = await prisma.team.upsert({
    where: { tenantId_name: { tenantId: acme.id, name: 'EMEA' } },
    update: {},
    create: { tenantId: acme.id, name: 'EMEA' },
  })

  const manager = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: acme.id, email: 'maya@acme.test' } },
    update: {},
    create: {
      tenantId: acme.id,
      email: 'maya@acme.test',
      name: 'Maya Iyer',
      role: 'manager',
      status: 'active',
      passwordHash,
      teamId: emea.id,
    },
  })

  await prisma.team.update({ where: { id: emea.id }, data: { managerId: manager.id } })

  for (const [email, name] of [
    ['rohan@acme.test', 'Rohan Desai'],
    ['sara@acme.test', 'Sara Khan'],
  ] as const) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: acme.id, email } },
      update: {},
      create: {
        tenantId: acme.id, email, name, role: 'rep',
        status: 'active', passwordHash, teamId: emea.id,
      },
    })
  }

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: acme.id, email: 'invited@acme.test' } },
    update: {},
    create: {
      tenantId: acme.id, email: 'invited@acme.test', name: 'Priya Nair',
      role: 'rep', status: 'invited',
    },
  })

  // Default pipeline so Phase 5 has stages to work with.
  const stages = [
    { name: 'Prospecting', order: 1, probability: 10 },
    { name: 'Discovery', order: 2, probability: 25 },
    { name: 'Proposal', order: 3, probability: 50 },
    { name: 'Negotiation', order: 4, probability: 75 },
    { name: 'Closed won', order: 5, probability: 100, isWon: true },
    { name: 'Closed lost', order: 6, probability: 0, isLost: true },
  ]
  for (const s of stages) {
    await prisma.pipelineStage.upsert({
      where: { tenantId_name: { tenantId: acme.id, name: s.name } },
      update: {},
      create: { tenantId: acme.id, ...s },
    })
  }

  await prisma.auditLog.create({
    data: {
      tenantId: acme.id, actorId: owner.id, action: 'create',
      entity: 'Tenant', entityId: acme.id,
      after: { name: acme.name, seeded: true },
    },
  })

  // --- Tenant 2: isolation counterparty ------------------------------------
  const globex = await prisma.tenant.upsert({
    where: { slug: 'globex' },
    update: {},
    create: { slug: 'globex', name: 'Globex Inc', plan: 'starter' },
  })

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: globex.id, email: 'admin@globex.test' } },
    update: {},
    create: {
      tenantId: globex.id, email: 'admin@globex.test', name: 'Globex Admin',
      role: 'owner', status: 'active', passwordHash,
    },
  })

  await prisma.account.upsert({
    where: { tenantId_domain: { tenantId: globex.id, domain: 'globex-secret.test' } },
    update: {},
    create: {
      tenantId: globex.id, name: 'Globex Confidential Client',
      domain: 'globex-secret.test',
    },
  })

  console.log('Seed complete.')
  console.log(`  Tenant: ${acme.name} (${acme.slug})`)
  console.log(`  Sign in: parthiv@acme.test / ${DEMO_PASSWORD}`)
  console.log(`  Second tenant for isolation tests: ${globex.slug}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
