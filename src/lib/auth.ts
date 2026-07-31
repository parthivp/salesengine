import 'server-only'
import { hashPassword, verifyPassword, validatePassword } from './password'
import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import type { User, Tenant, UserRole } from '@prisma/client'
import { prismaAdmin, withTenant, db } from './db'
import { generateToken, hashToken } from './crypto'
import { UnauthorizedError, ForbiddenError, can, visibilityScope, type Scope } from './rbac'
import { isProd } from './env'

const SESSION_COOKIE = 'se_session'
const SESSION_TTL_DAYS = 30

export type SessionUser = Pick<
  User,
  'id' | 'tenantId' | 'email' | 'name' | 'role' | 'status' | 'teamId' | 'timezone' | 'isPlatformAdmin'
>

export type AuthContext = {
  user: SessionUser
  tenant: Pick<Tenant, 'id' | 'slug' | 'name' | 'plan' | 'status'>
  scope: Scope
}

// --- passwords -------------------------------------------------------------

// Re-exported so existing imports from '@/lib/auth' keep working. The
// implementations live in './password', which does not import `server-only` and
// can therefore be used by the CLI scripts that create accounts.
export { hashPassword, verifyPassword, validatePassword }

export async function createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}) {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000)

  await prismaAdmin.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent },
  })

  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })

  return { token, expiresAt }
}

export async function destroySession() {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) {
    await prismaAdmin.session.deleteMany({ where: { tokenHash: hashToken(token) } })
  }
  jar.delete(SESSION_COOKIE)
}

/**
 * Resolves the caller. Uses prismaAdmin because we do not yet know which tenant
 * to scope to — that is precisely what this function determines. It is the one
 * sanctioned pre-tenant lookup, and it is keyed on a high-entropy token hash.
 */
export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null

  const session = await prismaAdmin.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { tenant: true } } },
  })

  if (!session || session.expiresAt < new Date()) return null

  const { user } = session
  if (user.status !== 'active') return null
  if (user.tenant.status !== 'active') return null

  let teamMemberIds: string[] = []
  if (user.role === 'manager' && user.teamId) {
    const members = await prismaAdmin.user.findMany({
      where: { tenantId: user.tenantId, teamId: user.teamId },
      select: { id: true },
    })
    teamMemberIds = members.map((m) => m.id)
  }

  return {
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      teamId: user.teamId,
      timezone: user.timezone,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    tenant: {
      id: user.tenant.id,
      slug: user.tenant.slug,
      name: user.tenant.name,
      plan: user.tenant.plan,
      status: user.tenant.status,
    },
    scope: visibilityScope(user.role, user.id, teamMemberIds),
  }
})

export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth()
  if (!auth) throw new UnauthorizedError()
  return auth
}

export async function requirePermission(permission: string): Promise<AuthContext> {
  const auth = await requireAuth()
  if (!can(auth.user.role, permission)) {
    throw new ForbiddenError(`Your role (${auth.user.role}) cannot ${permission}.`)
  }
  return auth
}

export async function requirePlatformAdmin(): Promise<AuthContext> {
  const auth = await requireAuth()
  if (!auth.user.isPlatformAdmin) throw new ForbiddenError('Platform admin only.')
  return auth
}

/**
 * The page-level counterparts. They report the refusal instead of throwing, so the
 * page can render it.
 *
 * Why not just call `requirePermission` in a page: a thrown ForbiddenError inside a
 * server component is an unhandled render error, which Next turns into a 500 with a
 * stack trace in the log. That is what /admin/integrations actually did for a rep —
 * the guard worked and the response was still wrong. A 500 also asserts something
 * untrue: the server is fine, the request was refused.
 *
 * The shape is a discriminated union rather than `AuthContext | null` so that the
 * refused branch carries no `auth` at all. Reaching for `guard.auth` without first
 * checking `guard.ok` is then a type error, which is the only reliable way to keep a
 * later edit from quietly querying as an unauthorised user.
 */
export type PageGuard =
  | { ok: true; auth: AuthContext }
  | { ok: false; role: UserRole }

export async function pagePermission(permission: string): Promise<PageGuard> {
  const auth = await getAuth()
  if (!auth) throw new UnauthorizedError()
  return can(auth.user.role, permission)
    ? { ok: true, auth }
    : { ok: false, role: auth.user.role }
}

export async function pagePlatformAdmin(): Promise<PageGuard> {
  const auth = await getAuth()
  if (!auth) throw new UnauthorizedError()
  return auth.user.isPlatformAdmin
    ? { ok: true, auth }
    : { ok: false, role: auth.user.role }
}

/**
 * The standard handler wrapper: authenticate, then run inside the caller's
 * tenant context so RLS is active for everything the handler touches.
 */
export async function withAuthTenant<T>(
  fn: (auth: AuthContext) => Promise<T>,
  permission?: string
): Promise<T> {
  const auth = permission ? await requirePermission(permission) : await requireAuth()
  return withTenant(auth.tenant.id, () => fn(auth))
}

// --- login -----------------------------------------------------------------

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string }

export async function login(email: string, password: string): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase()

  const users = await prismaAdmin.user.findMany({
    where: { email: normalized },
    include: { tenant: true },
    take: 2,
  })

  const user = users.find((u) => u.status === 'active' && u.tenant.status === 'active')

  // Constant-ish work whether or not the account exists, so timing does not
  // reveal which emails are registered.
  const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv'
  const valid = await verifyPassword(password, hash)

  if (!user || !valid) return { ok: false, error: 'Incorrect email or password.' }

  const h = await headers()
  await createSession(user.id, {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: h.get('user-agent') ?? undefined,
  })

  await prismaAdmin.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })

  await withTenant(user.tenantId, async () => {
    await db().auditLog.create({
      data: { tenantId: user.tenantId, actorId: user.id, action: 'login', entity: 'User', entityId: user.id },
    })
  })

  return {
    ok: true,
    user: {
      id: user.id, tenantId: user.tenantId, email: user.email, name: user.name,
      role: user.role, status: user.status, teamId: user.teamId,
      timezone: user.timezone, isPlatformAdmin: user.isPlatformAdmin,
    },
  }
}

export const ROLE_ORDER: UserRole[] = ['owner', 'admin', 'manager', 'rep']
