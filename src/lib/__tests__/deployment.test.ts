import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tests over the deployment manifests.
 *
 * These exist because of a bug that every other test in this repo would have
 * passed: `docker-compose.yml` gave the app and worker the *owner* database role,
 * which carries BYPASSRLS. Row-level security is the backstop for tenant
 * isolation, so the production deployment had it switched off — while the
 * isolation suite went on passing, because that runs against `.env`, which points
 * at the restricted role.
 *
 * The failure is invisible from inside the application: every query still carries
 * its `tenantId`, every permission check still runs, and the one mechanism meant
 * to catch a mistake in either is simply not enforcing. So the check has to be on
 * the manifest.
 */

const root = process.cwd()
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')

/** Lines of the form `KEY: value` under a service, crudely but adequately parsed. */
function envFor(service: string): Record<string, string> {
  const start = compose.indexOf(`\n  ${service}:`)
  expect(start, `service ${service} not found in docker-compose.yml`).toBeGreaterThan(-1)

  const rest = compose.slice(start + 1)
  const nextService = rest.slice(1).search(/\n {2}\w[\w-]*:\n/)
  const block = nextService === -1 ? rest : rest.slice(0, nextService + 1)

  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = /^\s{6}([A-Z][A-Z0-9_]*):\s*(.+)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

describe('the runtime database role', () => {
  it.each(['app', 'worker'])('%s connects as the restricted role, not the owner', (service) => {
    const url = envFor(service).DATABASE_URL
    expect(url, `${service} has no DATABASE_URL`).toBeTruthy()

    // The owner role bypasses RLS. Using it for the runtime turns tenant
    // isolation off completely, and nothing at runtime would report it.
    expect(url).toContain('salesengine_app:')
    expect(url).not.toMatch(/\/\/salesengine:/)
  })

  it.each(['app', 'worker'])('%s also gets a working owner connection', (service) => {
    // `prismaAdmin` uses DIRECT_DATABASE_URL at *runtime*, not only for
    // migrations: sessions carry no tenantId so no policy applies to them, and
    // the tracking, capture and scheduler paths are cross-tenant by nature.
    // Without this set, the container inherits `localhost` from .env, and the
    // first symptom is that nobody can log in — the app starts fine and serves
    // the login page before failing.
    const url = envFor(service).DIRECT_DATABASE_URL
    expect(url, `${service} has no DIRECT_DATABASE_URL`).toBeTruthy()
    expect(url).toContain('@postgres:')
    expect(url).not.toContain('localhost')
  })

  it('the migrate step uses the owner, because it administers roles and schema', () => {
    const env = envFor('migrate')
    expect(env.DATABASE_URL).toMatch(/\/\/salesengine:/)
    expect(env.DIRECT_DATABASE_URL).toMatch(/\/\/salesengine:/)
  })

  it('requires APP_DB_PASSWORD rather than defaulting it', () => {
    // `${VAR:?message}` makes compose refuse to start. A default here would ship
    // the placeholder password from the migration into production.
    const app = envFor('app').DATABASE_URL
    expect(app).toContain('APP_DB_PASSWORD:?')
    expect(app).not.toContain('APP_DB_PASSWORD:-')
  })

  it('verifies row-level security as part of the deploy', () => {
    // provision-db.ts exits non-zero when a tenant-scoped table has no policy,
    // and app/worker wait on migrate completing successfully — so an unprotected
    // table stops the deploy instead of going live.
    expect(compose).toContain('provision-db.ts')
    expect(compose).toContain('service_completed_successfully')
  })
})

describe('the provisioning script', () => {
  const script = readFileSync(join(root, 'scripts/provision-db.ts'), 'utf8')

  it('derives the table list from the schema rather than hardcoding it', () => {
    // A hardcoded list misses exactly the case it exists to catch: a new
    // tenant-scoped table that nobody remembered to protect.
    expect(script).toContain("a.attname = 'tenantId'")
  })

  it('checks FORCE as well as ENABLE', () => {
    // ENABLE alone does not apply to the table's owner, so a policy can be
    // present and enabled and still not constrain the role doing the querying.
    expect(script).toContain('relforcerowsecurity')
    expect(script).toContain('relrowsecurity')
  })

  it('fails the deploy rather than warning', () => {
    expect(script).toContain('process.exit(1)')
  })

  it('names a fix command that actually exists with that signature', () => {
    // The first version told the operator to run `apply_tenant_rls('<table>')`,
    // which does not exist — the function takes no arguments.
    const migration = findRlsMigration()
    expect(migration).toContain('FUNCTION public.apply_tenant_rls() RETURNS void')
    expect(script).toContain('apply_tenant_rls()')
    expect(script).not.toMatch(/apply_tenant_rls\('/)
  })
})

function findRlsMigration(): string {
  const dir = join(root, 'prisma/migrations')
  const folder = readdirSync(dir).find((d) => d.includes('tenant_rls'))
  expect(folder, 'tenant_rls migration not found').toBeTruthy()
  const file = join(dir, folder!, 'migration.sql')
  expect(existsSync(file)).toBe(true)
  return readFileSync(file, 'utf8')
}

describe('the Dockerfile', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

  it('ships the standalone server, its static assets, and the worker sources', () => {
    // `next start` does not work with output: 'standalone'; the runner must launch
    // server.js. And static assets live outside the standalone bundle, so missing
    // that COPY produces a running app with no CSS.
    expect(dockerfile).toContain('.next/standalone')
    expect(dockerfile).toContain('.next/static')
    expect(dockerfile).toContain('CMD ["node", "server.js"]')
    expect(dockerfile).toContain('/app/src ./src')
    expect(dockerfile).toContain('/app/prisma ./prisma')
  })

  it('does not bake a real secret into the image', () => {
    // Placeholders are needed at build time for `prisma generate` and the Next
    // build; they must be obviously inert.
    const buildEnv = dockerfile.match(/^ENV (AUTH_SECRET|ENCRYPTION_KEY)=.*$/gm) ?? []
    expect(buildEnv.length).toBeGreaterThan(0)
    for (const line of buildEnv) {
      expect(line.toLowerCase()).toMatch(/placeholder|build/)
    }
  })

  it('runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER nextjs$/m)
  })
})
