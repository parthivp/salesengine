'use server'

import { z } from 'zod'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { prismaAdmin } from '@/lib/db'
import { hashToken } from '@/lib/crypto'
import { hashPassword, validatePassword, createSession } from '@/lib/auth'
import { logger } from '@/lib/logger'

const schema = z.object({
  token: z.string().min(10),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
})

export type AcceptResult = { ok: false; error: string }

/**
 * Accepts an invitation: sets the password, activates the user, signs them in.
 *
 * On success it redirects rather than returning, so the only return type is a
 * failure. The whole thing is one transaction: a crash between "password set" and
 * "invite consumed" would otherwise leave a reusable token pointing at an account
 * that now has a password.
 */
export async function acceptInvite(input: z.infer<typeof schema>): Promise<AcceptResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid request.' }
  const d = parsed.data

  const problem = validatePassword(d.password)
  if (problem) return { ok: false, error: problem }

  let userId: string
  try {
    const passwordHash = await hashPassword(d.password)

    const result = await prismaAdmin.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { tokenHash: hashToken(d.token) } })
      if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) return null

      const user = await tx.user.findFirst({
        where: { tenantId: invite.tenantId, email: invite.email },
      })
      if (!user) return null

      // Refuse if the account is already usable. An invite link that still works
      // after the account is live is a password reset for anyone holding it.
      if (user.status === 'active' && user.passwordHash) return null

      await tx.user.update({
        where: { id: user.id },
        data: {
          name: d.name,
          passwordHash,
          status: 'active',
          role: invite.role,
          teamId: invite.teamId ?? user.teamId,
        },
      })

      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } })

      await tx.auditLog.create({
        data: {
          tenantId: invite.tenantId,
          actorId: user.id,
          action: 'create',
          entity: 'User',
          entityId: user.id,
          after: { status: 'active', via: 'invite' },
        },
      })

      return user.id
    })

    if (!result) return { ok: false, error: 'This invitation cannot be used. Ask for a new one.' }
    userId = result
  } catch (err) {
    logger.error({ err }, 'invite acceptance failed')
    return { ok: false, error: 'Could not complete that. Try again.' }
  }

  const h = await headers()
  await createSession(userId, {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: h.get('user-agent') ?? undefined,
  })

  redirect('/dashboard')
}
