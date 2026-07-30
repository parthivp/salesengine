import { withTenant, db, prismaAdmin } from './db'
import { env } from './env'
import { sendingEnabled } from './email/send'
import { workerStatus, redisReachable } from './health'
import { imapCredentialsFrom } from './email/imap'

/**
 * "Is this thing actually ready to run my pipeline?"
 *
 * Every check here corresponds to a way the system can look healthy and do
 * nothing. A dashboard full of zeroes reads as "a quiet week" whether the cause is
 * a quiet week, a dead worker, an unverified sending domain, or a mailbox nobody
 * polls — and those need very different responses. The point of this module is to
 * answer that question in one place rather than leaving it to be inferred.
 *
 * Severities mean what they say:
 *   blocker — nothing works until this is fixed
 *   warning — it works, but something is silently degraded
 *   info    — worth knowing, not wrong
 */

export type Severity = 'blocker' | 'warning' | 'info' | 'ok'

export type Check = {
  id: string
  area: 'Infrastructure' | 'Sending' | 'Replies' | 'Data' | 'Security'
  label: string
  severity: Severity
  detail: string
  /** What to do about it, when there is something to do. */
  fix?: string
}

export type Readiness = {
  checks: Check[]
  blockers: number
  warnings: number
  ready: boolean
}

const PLACEHOLDER_DB_PASSWORD = 'salesengine_app'

export async function assess(tenantId: string): Promise<Readiness> {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)

  // --- infrastructure -------------------------------------------------------
  const redisOk = await redisReachable()
  add({
    id: 'redis',
    area: 'Infrastructure',
    label: 'Redis',
    severity: redisOk ? 'ok' : 'blocker',
    detail: redisOk ? 'Reachable.' : 'Unreachable — no background job can run.',
    fix: redisOk ? undefined : 'Check REDIS_URL and that the redis service is up.',
  })

  const worker = await workerStatus()
  add({
    id: 'worker',
    area: 'Infrastructure',
    label: 'Worker process',
    severity: worker.state === 'alive' ? 'ok' : worker.state === 'unknown' ? 'warning' : 'blocker',
    detail:
      worker.state === 'alive'
        ? `Checked in ${Math.round(worker.ageMs / 1000)}s ago, draining ${worker.queues.length} queues.`
        : worker.message,
    fix:
      worker.state === 'alive'
        ? undefined
        : 'Start it with `npm run worker`, or `docker compose up -d worker`.',
  })

  const pending = await pendingMigrations()
  add({
    id: 'migrations',
    area: 'Infrastructure',
    label: 'Database migrations',
    severity: pending === 0 ? 'ok' : 'blocker',
    detail: pending === 0 ? 'Up to date.' : `${pending} migration(s) not applied.`,
    fix: pending === 0 ? undefined : 'Run `npm run db:deploy`.',
  })

  // --- security -------------------------------------------------------------
  const usingPlaceholder = env.DATABASE_URL.includes(`:${PLACEHOLDER_DB_PASSWORD}@`)
  add({
    id: 'db-password',
    area: 'Security',
    label: 'Runtime database password',
    severity: usingPlaceholder ? 'warning' : 'ok',
    detail: usingPlaceholder
      ? 'Still the placeholder the migration created.'
      : 'Not the placeholder.',
    fix: usingPlaceholder
      ? 'Set APP_DB_PASSWORD and run `npm run db:provision`, then update DATABASE_URL.'
      : undefined,
  })

  // Not a strength meter — just the one case that is unambiguously wrong.
  const weakSecret = env.AUTH_SECRET.length < 32 || /^(.)\1+$/.test(env.AUTH_SECRET)
  add({
    id: 'auth-secret',
    area: 'Security',
    label: 'Session signing key',
    severity: weakSecret ? 'blocker' : 'ok',
    detail: weakSecret ? 'Too short or trivially repetitive.' : 'Set.',
    fix: weakSecret ? 'Generate one with `openssl rand -hex 32`.' : undefined,
  })

  const usingOwner = env.DATABASE_URL.includes('//salesengine:')
  add({
    id: 'db-role',
    area: 'Security',
    label: 'Tenant isolation backstop',
    severity: usingOwner ? 'blocker' : 'ok',
    detail: usingOwner
      ? 'The app is connected as the database owner, which bypasses row-level security. ' +
        'Tenant isolation is not being enforced.'
      : 'Connected as the restricted role, so row-level security applies.',
    fix: usingOwner
      ? 'Point DATABASE_URL at salesengine_app. Keep the owner only for DIRECT_DATABASE_URL.'
      : undefined,
  })

  // --- tenant-scoped --------------------------------------------------------
  await withTenant(tenantId, async () => {
    const [mailboxes, sequences, contacts, crm] = await Promise.all([
      db().mailbox.findMany(),
      db().sequence.count({ where: { status: 'active' } }),
      db().contact.count(),
      db().crmConnection.count(),
    ])

    // --- sending ------------------------------------------------------------
    add({
      id: 'transport',
      area: 'Sending',
      label: 'Email transport',
      severity: sendingEnabled() ? 'ok' : 'warning',
      detail: sendingEnabled()
        ? `Live — mail will actually be sent (${env.EMAIL_TRANSPORT}).`
        : `EMAIL_TRANSPORT is "${env.EMAIL_TRANSPORT}", so messages are logged and never sent.`,
      fix: sendingEnabled() ? undefined : 'Set EMAIL_TRANSPORT=ses once your domain is verified.',
    })

    if (mailboxes.length === 0) {
      add({
        id: 'mailboxes',
        area: 'Sending',
        label: 'Mailboxes',
        severity: 'blocker',
        detail: 'None configured — there is nothing to send from.',
        fix: 'Add one under Mailboxes.',
      })
    } else {
      const unauthenticated = mailboxes.filter((m) => !m.spfOk || !m.dkimOk)
      const blocked = mailboxes.filter((m) => m.health === 'blocked' || m.health === 'disconnected')
      add({
        id: 'mailboxes',
        area: 'Sending',
        label: 'Mailboxes',
        severity: blocked.length === mailboxes.length ? 'blocker' : unauthenticated.length ? 'warning' : 'ok',
        detail:
          `${mailboxes.length} configured` +
          (unauthenticated.length ? `, ${unauthenticated.length} failing SPF or DKIM` : '') +
          (blocked.length ? `, ${blocked.length} blocked` : '') +
          '.',
        fix: unauthenticated.length
          ? 'Fix the DNS records, then re-check on the Mailboxes page. Unauthenticated mail goes to spam.'
          : undefined,
      })

      const warming = mailboxes.filter((m) => m.health === 'warming')
      if (warming.length) {
        add({
          id: 'warmup',
          area: 'Sending',
          label: 'Warm-up',
          severity: 'info',
          detail: `${warming.length} mailbox(es) still warming, so daily caps are low on purpose.`,
        })
      }
    }

    // --- replies ------------------------------------------------------------
    const polled = mailboxes.filter((m) => imapCredentialsFrom(m.credentials))
    const failing = polled.filter((m) => m.imapLastError)
    add({
      id: 'reply-polling',
      area: 'Replies',
      label: 'Reply collection',
      // A warning rather than a blocker: sending still works. But it is the most
      // consequential warning here, because without it a sequence keeps emailing
      // someone who already wrote back.
      severity: polled.length === 0 ? 'warning' : failing.length ? 'warning' : 'ok',
      detail:
        polled.length === 0
          ? 'No mailbox is polled, so replies are never detected and sequences will keep sending to people who have answered.'
          : failing.length
            ? `${failing.length} of ${polled.length} mailbox(es) failing to poll.`
            : `${polled.length} mailbox(es) polled.`,
      fix: polled.length === 0 ? 'Add IMAP details to a mailbox under Mailboxes.' : undefined,
    })

    // --- data ---------------------------------------------------------------
    add({
      id: 'contacts',
      area: 'Data',
      label: 'Contacts',
      severity: contacts === 0 ? 'warning' : 'ok',
      detail: contacts === 0 ? 'None yet.' : `${contacts.toLocaleString()} in the database.`,
      fix: contacts === 0 ? 'Import a CSV, or connect a CRM.' : undefined,
    })

    add({
      id: 'sequences',
      area: 'Data',
      label: 'Active sequences',
      severity: sequences === 0 ? 'info' : 'ok',
      detail: sequences === 0 ? 'None active.' : `${sequences} running.`,
    })

    add({
      id: 'crm',
      area: 'Data',
      label: 'CRM',
      severity: 'info',
      detail: crm === 0 ? 'Not connected.' : `${crm} connection(s).`,
    })

    add({
      id: 'enrichment',
      area: 'Data',
      label: 'Enrichment',
      severity: 'info',
      detail: env.APOLLO_API_KEY
        ? 'Apollo key present.'
        : 'No Apollo key — enrichment is skipped rather than failing.',
    })
  })

  const blockers = checks.filter((c) => c.severity === 'blocker').length
  const warnings = checks.filter((c) => c.severity === 'warning').length
  return { checks, blockers, warnings, ready: blockers === 0 }
}

/**
 * Migrations recorded as applied versus present on disk.
 *
 * Reads Prisma's own `_prisma_migrations` table rather than shelling out to the
 * CLI, so this works inside a running container that has no dev dependencies.
 */
async function pendingMigrations(): Promise<number> {
  try {
    const { readdirSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(process.cwd(), 'prisma/migrations')
    if (!existsSync(dir)) return 0

    const onDisk = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)

    const applied = await prismaAdmin.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `
    const appliedNames = new Set(applied.map((a) => a.migration_name))
    return onDisk.filter((m) => !appliedNames.has(m)).length
  } catch {
    // No migrations table at all means nothing has ever been applied.
    return 1
  }
}
