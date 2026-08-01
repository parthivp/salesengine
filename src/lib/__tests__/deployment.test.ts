import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

describe('the base image', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

  it('is glibc, because musl cannot resolve Microsoft to IPv4', () => {
    // musl returned only AAAA records for login.microsoftonline.com, and Docker
    // Desktop gives containers no IPv6 route — so every Graph call failed with
    // ENETUNREACH. No Node flag fixes it: there were no IPv4 addresses to prefer.
    expect(dockerfile).not.toMatch(/FROM node:\d+-alpine/)
    expect(dockerfile).toMatch(/FROM node:\d+-slim/)
  })

  it('points the entrypoint at tini where this base actually puts it', () => {
    // Alpine ships tini at /sbin/tini, Debian at /usr/bin/tini. Getting this
    // wrong does not fail the build — it fails at container start, every time,
    // with an exec error and no application logs at all.
    const usesApt = /apt-get install[^\n]*\btini\b/.test(dockerfile)
    const usesApk = /apk add[^\n]*\btini\b/.test(dockerfile)
    expect(usesApt !== usesApk, 'exactly one package manager should install tini').toBe(true)

    const entrypoint = /ENTRYPOINT \["([^"]+)"/.exec(dockerfile)?.[1]
    expect(entrypoint).toBe(usesApt ? '/usr/bin/tini' : '/sbin/tini')
  })

  it('does not install the Alpine-only glibc shim on a glibc base', () => {
    // libc6-compat exists to fake glibc on musl. On Debian it is meaningless,
    // and leaving it behind is the sign of a half-finished migration.
    expect(dockerfile).not.toContain('libc6-compat')
  })
})

describe('outbound network from the containers', () => {
  // Microsoft's endpoints publish AAAA records; Node 18+ does not prefer IPv4;
  // Docker Desktop gives containers no IPv6 route. The three together make every
  // Graph call fail with ENETUNREACH, reported as a bare "fetch failed" that
  // implicates the credentials instead. Both processes talk to Graph — the app
  // when verifying a mailbox, the worker on every poll and send — so both need it.
  for (const service of ['app', 'worker'] as const) {
    it(`${service} resolves IPv4 first, so Graph is reachable on Docker Desktop`, () => {
      expect(envFor(service).NODE_OPTIONS ?? '').toContain('--dns-result-order=ipv4first')
    })
  }
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

  it('only copies paths that exist in a clean clone', () => {
    // The bug this exists for: `COPY /app/public ./public` referenced a directory
    // that was empty and therefore untracked, since git does not store empty
    // directories. Every working tree that had created it locally built fine; a
    // fresh clone failed with `"/app/public": not found`. Checking the filesystem
    // is not enough — the question is whether git would reproduce it.
    const copied = [...dockerfile.matchAll(/^COPY(?:\s+--\S+)*\s+(\S+)\s+\S+$/gm)]
      .map((m) => m[1])
      .filter((src) => !src.startsWith('--'))
      // Two things reach the runner from the builder stage without ever being in
      // the repo: `.next` is produced by `next build`, and `node_modules` by
      // `npm ci`. Everything else the builder has, it got from `COPY . .` — so it
      // must be something a clean clone actually contains.
      .filter((src) => !/^\/app\/(\.next|node_modules)/.test(src))
      .map((src) => src.replace(/^\/app\//, ''))
      .filter((src) => src !== '.' && !src.includes('*'))

    expect(copied.length).toBeGreaterThan(0)

    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)

    for (const src of copied) {
      const isTracked = tracked.some((f) => f === src || f.startsWith(`${src}/`))
      expect(isTracked, `Dockerfile copies "${src}", which no tracked file lives under`).toBe(true)
    }
  })

  it('contains every file it is asked to run', () => {
    // The complement of the test above, and the one that would have caught the
    // real failure: the runner stage copied src/ and prisma/ but not scripts/,
    // while the compose `migrate` step runs scripts/provision-db.ts. Migrations
    // applied, then the container died with ERR_MODULE_NOT_FOUND. Steps that come
    // later — create-tenant.ts, check.ts — would have failed the same way.
    //
    // Checking that copied paths exist is not enough; the referenced paths have to
    // be covered too, and nothing else compares those two lists.
    const referenced = new Set(
      [
        ...compose.matchAll(/(?:npx tsx|node)\s+(scripts\/[\w.-]+\.(?:ts|mjs))/g),
        ...readFileSync(join(root, 'DEPLOYMENT.md'), 'utf8')
          .split('\n')
          // Only lines that run something *inside* a container. init-env.mjs runs
          // on the host through a bind mount, so it need not be in the image.
          .filter((l) => l.includes('docker compose exec'))
          .join('\n')
          .matchAll(/(scripts\/[\w.-]+\.(?:ts|mjs))/g),
      ].map((m) => m[1])
    )

    expect(referenced.size).toBeGreaterThan(0)

    const copiedDirs = [...dockerfile.matchAll(/^COPY(?:\s+--\S+)*\s+\/app\/(\S+)\s+\S+$/gm)].map(
      (m) => m[1]
    )

    for (const ref of referenced) {
      const dir = ref.split('/')[0]
      expect(
        copiedDirs.includes(dir),
        `the image runs "${ref}" but the Dockerfile never copies "${dir}/"`
      ).toBe(true)
      expect(existsSync(join(root, ref)), `${ref} does not exist`).toBe(true)
    }
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
