import { PrismaClient, Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'
import { env, isDev } from './env'

/**
 * Tenant isolation, layer 1.
 *
 * Layer 2 is Postgres RLS (prisma/migrations/*_tenant_rls). This file is the
 * ergonomic layer: it sets `app.current_tenant` for the duration of a unit of
 * work and auto-injects `tenantId` into writes so callers cannot forget.
 *
 * Because Prisma pools connections, `app.current_tenant` must be set with
 * transaction scope (`set_config(..., true)`) and every query in the unit of
 * work must run on that same connection — hence the interactive transaction.
 * Keep the callback to database work only; do not await HTTP inside it.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  prismaAdmin?: PrismaClient
}

function createClient(url: string) {
  return new PrismaClient({
    datasources: { db: { url } },
    log: isDev ? ['warn', 'error'] : ['error'],
  })
}

/** Runtime client. Connects as the restricted role; RLS applies. */
export const prisma = globalForPrisma.prisma ?? createClient(env.DATABASE_URL)

/**
 * Owner client with BYPASSRLS. Only for platform-level work: tenant creation,
 * super-admin views, migrations, seeds. Never reachable from a tenant request path.
 */
export const prismaAdmin =
  globalForPrisma.prismaAdmin ??
  createClient(env.DIRECT_DATABASE_URL ?? env.DATABASE_URL)

if (isDev) {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaAdmin = prismaAdmin
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

export type TenantTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

type TenantContext = { tenantId: string; tx: TenantTx }

const storage = new AsyncLocalStorage<TenantContext>()

/** Models that carry a tenantId column and should be auto-scoped. */
const TENANT_MODELS = new Set<string>([
  'User', 'Team', 'Account', 'Contact', 'Lead', 'Sequence',
  'SequenceEnrollment', 'Mailbox', 'EmailMessage', 'EmailTemplate', 'Task',
  'Deal', 'PipelineStage', 'CrmConnection', 'SuppressionEntry', 'AuditLog',
  'CustomFieldDef', 'ContactList', 'CaptureForm', 'Invite', 'ApiKey',
  'UsageCounter', 'Activity',
])

const WRITE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert'])

/**
 * Runs `fn` with `app.current_tenant` bound to `tenantId`. Every query issued
 * through `db()` inside the callback is isolated to that tenant by the database
 * itself, not merely by convention.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
  opts: { timeout?: number } = {}
): Promise<T> {
  if (!tenantId) throw new Error('withTenant called without a tenantId')

  return prisma.$transaction(
    async (tx) => {
      // Transaction-scoped, so it cannot leak to the next borrower of this connection.
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`
      return storage.run({ tenantId, tx: tx as TenantTx }, fn)
    },
    { timeout: opts.timeout ?? 15_000, maxWait: 5_000 }
  )
}

/** The tenant-scoped client for the current unit of work. Throws outside `withTenant`. */
export function db(): TenantTx {
  const ctx = storage.getStore()
  if (!ctx) {
    throw new Error(
      'db() called outside a tenant context. Wrap the call in withTenant(tenantId, ...) ' +
        'or use prismaAdmin for platform-level work.'
    )
  }
  return ctx.tx
}

/** The tenant id for the current unit of work, if any. */
export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null
}

/** True when executing inside a tenant context. */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined
}

/**
 * Auto-injects the ambient tenantId into creates so application code never has
 * to pass it. Reads are already constrained by RLS, so this deliberately does
 * not rewrite `where` clauses — that would hide bugs the database will catch.
 */
export const tenantScoped = Prisma.defineExtension({
  name: 'tenantScoped',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const tenantId = currentTenantId()
        if (!tenantId || !model || !TENANT_MODELS.has(model)) return query(args)
        if (!WRITE_OPS.has(operation)) return query(args)

        const a = args as Record<string, unknown>
        if (operation === 'createMany' || operation === 'createManyAndReturn') {
          const data = a.data
          if (Array.isArray(data)) {
            a.data = data.map((d) => ({ tenantId, ...(d as object) }))
          } else if (data && typeof data === 'object') {
            a.data = { tenantId, ...(data as object) }
          }
        } else if (operation === 'upsert') {
          if (a.create && typeof a.create === 'object') {
            a.create = { tenantId, ...(a.create as object) }
          }
        } else if (a.data && typeof a.data === 'object') {
          a.data = { tenantId, ...(a.data as object) }
        }
        return query(a)
      },
    },
  },
})

/** Graceful shutdown for the worker process. */
export async function disconnect() {
  await Promise.allSettled([prisma.$disconnect(), prismaAdmin.$disconnect()])
}
