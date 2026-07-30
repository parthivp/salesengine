'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid, prismaAdmin } from '@/lib/db'
import { checkSeatQuota } from '@/lib/limits'
import { generateToken, hashToken } from '@/lib/crypto'
import { normalizeEmail } from '@/lib/utils'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'
import type { UserRole } from '@prisma/client'

/**
 * User administration.
 *
 * The seat limit is enforced here. It existed on the tenant, was displayed, and
 * bounded nothing — which is worse than having no limit, because the operator
 * believes they are protected by it.
 */

export type UserResult =
  | { ok: true; inviteUrl?: string; message?: string }
  | { ok: false; error: string }

const INVITE_TTL_DAYS = 14

const inviteSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['owner', 'admin', 'manager', 'rep']),
})

export async function inviteUser(input: z.infer<typeof inviteSchema>): Promise<UserResult> {
  const auth = await requirePermission('user:invite')
  const parsed = inviteSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

  const d = parsed.data
  const email = normalizeEmail(d.email)
  if (!email) return { ok: false, error: 'That does not look like an email address.' }

  // Only an owner may create another owner. Otherwise an admin can promote
  // themselves sideways into the one role that can remove them.
  if (d.role === 'owner' && auth.user.role !== 'owner') {
    return { ok: false, error: 'Only an owner can invite another owner.' }
  }

  try {
    return await withTenant(auth.tenant.id, async () => {
      const existing = await db().user.findFirst({ where: { email } })
      if (existing) {
        return { ok: false as const, error: `${email} is already in this workspace.` }
      }

      const seats = await checkSeatQuota()
      if (!seats.allowed) {
        return {
          ok: false as const,
          error: `${seats.reason} Raise the seat limit or disable a user before inviting another.`,
        }
      }

      // Raw token to the inviter, hash to the database — the same shape as a
      // session token. A stored invite token is a password-reset primitive, and a
      // database dump should not hand over every pending account.
      const token = generateToken()
      const invite = await db().invite.create({
        data: {
          tenantId: tid(),
          email,
          role: d.role as UserRole,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
          invitedById: auth.user.id,
        },
      })

      // The user row exists immediately, in `invited` state, so the seat is held
      // and the person can be assigned records before they first sign in.
      await db().user.create({
        data: {
          tenantId: tid(),
          email,
          name: d.name,
          role: d.role as UserRole,
          status: 'invited',
          timezone: auth.user.timezone,
        },
      })

      await audit({
        actorId: auth.user.id,
        action: 'invite',
        entity: 'User',
        entityId: invite.id,
        after: { email, role: d.role },
      })

      revalidatePath('/admin/users')
      return {
        ok: true as const,
        inviteUrl: `${env.APP_URL}/invite/${token}`,
        message: `${email} can now set a password using the link below. It expires in ${INVITE_TTL_DAYS} days.`,
      }
    })
  } catch (err) {
    logger.error({ err, email }, 'invite failed')
    return { ok: false, error: 'Could not create that invitation.' }
  }
}

const roleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['owner', 'admin', 'manager', 'rep']),
})

export async function changeRole(input: z.infer<typeof roleSchema>): Promise<UserResult> {
  const auth = await requirePermission('user:update')
  const parsed = roleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid request.' }
  const d = parsed.data

  if (d.userId === auth.user.id) {
    return { ok: false, error: 'You cannot change your own role.' }
  }
  if (d.role === 'owner' && auth.user.role !== 'owner') {
    return { ok: false, error: 'Only an owner can promote someone to owner.' }
  }

  try {
    return await withTenant(auth.tenant.id, async () => {
      const target = await db().user.findUnique({ where: { id: d.userId } })
      if (!target) return { ok: false as const, error: 'That user is no longer here.' }

      if (target.role === 'owner' && auth.user.role !== 'owner') {
        return { ok: false as const, error: 'Only an owner can change another owner.' }
      }

      // A workspace with no owner cannot be administered by anyone, and nothing
      // else in the app would notice until someone needed to change billing or
      // remove a user.
      if (target.role === 'owner' && d.role !== 'owner') {
        const owners = await db().user.count({ where: { role: 'owner', status: 'active' } })
        if (owners <= 1) {
          return { ok: false as const, error: 'This is the last owner. Promote someone else first.' }
        }
      }

      await db().user.update({ where: { id: d.userId }, data: { role: d.role as UserRole } })
      await audit({
        actorId: auth.user.id,
        action: 'update',
        entity: 'User',
        entityId: d.userId,
        before: { role: target.role },
        after: { role: d.role },
      })

      revalidatePath('/admin/users')
      return { ok: true as const, message: `${target.name} is now ${d.role}.` }
    })
  } catch (err) {
    logger.error({ err, userId: d.userId }, 'role change failed')
    return { ok: false, error: 'Could not change that role.' }
  }
}

export async function setUserStatus(userId: string, disable: boolean): Promise<UserResult> {
  const auth = await requirePermission('user:disable')

  if (userId === auth.user.id) return { ok: false, error: 'You cannot disable yourself.' }

  try {
    return await withTenant(auth.tenant.id, async () => {
      const target = await db().user.findUnique({ where: { id: userId } })
      if (!target) return { ok: false as const, error: 'That user is no longer here.' }

      if (disable && target.role === 'owner') {
        const owners = await db().user.count({ where: { role: 'owner', status: 'active' } })
        if (owners <= 1) {
          return { ok: false as const, error: 'This is the last owner. Promote someone else first.' }
        }
      }

      if (!disable) {
        // Re-enabling consumes a seat, so it is checked like an invitation.
        const seats = await checkSeatQuota()
        if (!seats.allowed) return { ok: false as const, error: seats.reason ?? 'No seats available.' }
      }

      await db().user.update({
        where: { id: userId },
        data: { status: disable ? 'disabled' : 'active' },
      })

      // Disabling must end their sessions. Otherwise a disabled user keeps working
      // until their cookie happens to expire, which can be weeks.
      if (disable) {
        const { count } = await prismaAdmin.session.deleteMany({ where: { userId } })
        logger.info({ userId, sessions: count }, 'user disabled; sessions revoked')
      }

      await audit({
        actorId: auth.user.id,
        action: 'update',
        entity: 'User',
        entityId: userId,
        before: { status: target.status },
        after: { status: disable ? 'disabled' : 'active' },
      })

      revalidatePath('/admin/users')
      return {
        ok: true as const,
        message: disable ? `${target.name} is disabled and signed out.` : `${target.name} is active again.`,
      }
    })
  } catch (err) {
    logger.error({ err, userId }, 'status change failed')
    return { ok: false, error: 'Could not change that user.' }
  }
}
