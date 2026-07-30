import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

/**
 * Post-migration database provisioning, run once per deploy.
 *
 * Three jobs, in order of how badly they fail when skipped:
 *
 * 1. **Verify row-level security is actually on.** Tenant isolation rests on RLS
 *    being enabled and FORCEd on every table carrying a `tenantId`. A migration
 *    that adds a table and forgets the policy creates a table any tenant can read
 *    from any other — and nothing else in the system would notice, because the
 *    application-level scoping still looks correct. This exits non-zero, so a
 *    deploy fails rather than silently shipping a hole.
 *
 * 2. **Set the runtime role's password** from `APP_DB_PASSWORD`. The migration
 *    creates `salesengine_app` with a placeholder, because a migration cannot read
 *    your secrets. Leaving the placeholder in production is a default credential
 *    on the account that holds all customer data.
 *
 * 3. **Re-grant on anything new.** Default privileges cover tables created by the
 *    same role, but a table created by a different path would otherwise be
 *    invisible to the app.
 *
 * Runs as the owner (DIRECT_DATABASE_URL) — it is administering roles, which the
 * restricted role by definition cannot do.
 */

const APP_ROLE = 'salesengine_app'

const adminUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL
if (!adminUrl) {
  console.error('DIRECT_DATABASE_URL or DATABASE_URL must be set.')
  process.exit(1)
}

const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })

type TableCheck = { table: string; rlsEnabled: boolean; rlsForced: boolean; hasPolicy: boolean }

async function checkRls(): Promise<TableCheck[]> {
  // Every table with a tenantId column is in scope. Deriving the list from the
  // schema rather than hardcoding it is the point: a new tenant-scoped table is
  // caught automatically, which is exactly the case a hardcoded list misses.
  return admin.$queryRaw<TableCheck[]>`
    SELECT
      c.relname::text AS "table",
      c.relrowsecurity AS "rlsEnabled",
      c.relforcerowsecurity AS "rlsForced",
      EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS "hasPolicy"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      )
    ORDER BY c.relname
  `
}

async function main() {
  const password = process.env.APP_DB_PASSWORD

  // --- 1. the runtime role -------------------------------------------------
  const roles = await admin.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS "exists"
  `
  if (!roles[0]?.exists) {
    console.error(
      `Role ${APP_ROLE} does not exist. Run "prisma migrate deploy" before this script.`
    )
    process.exit(1)
  }

  if (password) {
    // Parameterised where possible, but ALTER ROLE will not take a bind
    // parameter for the password, so it is quoted by Postgres itself via
    // quote_literal rather than by string concatenation here.
    await admin.$executeRawUnsafe(
      `DO $$ BEGIN EXECUTE format('ALTER ROLE ${APP_ROLE} PASSWORD %L', $1); END $$;`,
      password
    ).catch(async () => {
      // Older servers reject parameters inside a DO block; fall back to a
      // server-side quote so the password is still never concatenated raw.
      const [{ quoted }] = await admin.$queryRaw<{ quoted: string }[]>`
        SELECT quote_literal(${password}::text) AS quoted
      `
      await admin.$executeRawUnsafe(`ALTER ROLE ${APP_ROLE} PASSWORD ${quoted}`)
    })
    console.log(`✓ ${APP_ROLE} password set from APP_DB_PASSWORD`)
  } else {
    console.warn(
      `! APP_DB_PASSWORD is not set, so ${APP_ROLE} keeps the placeholder password from the ` +
        `migration. Set it before exposing this deployment to anything.`
    )
  }

  // --- 2. grants -----------------------------------------------------------
  await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`)
  await admin.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`
  )
  await admin.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`
  )
  console.log(`✓ grants refreshed for ${APP_ROLE}`)

  // --- 3. the check that matters -------------------------------------------
  const tables = await checkRls()
  const broken = tables.filter((t) => !t.rlsEnabled || !t.rlsForced || !t.hasPolicy)

  console.log(`\nRow-level security across ${tables.length} tenant-scoped tables:`)
  for (const t of broken) {
    const missing = [
      !t.rlsEnabled && 'not enabled',
      !t.rlsForced && 'not FORCEd',
      !t.hasPolicy && 'no policy',
    ]
      .filter(Boolean)
      .join(', ')
    console.error(`  ✗ ${t.table}: ${missing}`)
  }

  if (broken.length > 0) {
    console.error(
      `\n${broken.length} of ${tables.length} tables would be readable across tenants.\n` +
        `Fix with: SELECT apply_tenant_rls();  -- takes no arguments; re-applies to every\n` +
        `tenant-scoped table, and is safe to run repeatedly.\n` +
        `Refusing to complete the deploy.`
    )
    process.exit(1)
  }

  console.log(`  ✓ all ${tables.length} enabled, FORCEd, and carrying a policy`)
  console.log('\nProvisioning complete.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => admin.$disconnect())
