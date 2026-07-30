import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { buildQueue, recordAction } from '@/lib/linkedin/queue'
import { assessPacing, withinLimit, type LinkedInActionType } from '@/lib/linkedin/policy'
import { logger } from '@/lib/logger'
import { UnauthorizedError } from '@/lib/rbac'

/**
 * The endpoint the Chrome extension talks to.
 *
 * Authenticated by the user's ordinary SalesEngine session cookie — the extension
 * holds no token of its own, so there is nothing in it to steal, and revoking
 * access is just signing out.
 *
 * Deliberately *not* CORS-open. `credentials: 'include'` from an extension
 * background worker sends the cookie, and an `Access-Control-Allow-Origin: *`
 * response with credentials is rejected by the browser anyway. Echoing back a
 * chrome-extension origin would make this endpoint reachable by any extension the
 * user has installed, which is a worse trade than requiring same-origin.
 */

export async function GET() {
  let auth
  try {
    auth = await requireAuth()
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'signed_out' }, { status: 401 })
    }
    throw err
  }

  try {
    const { cards, pacing } = await withTenant(auth.tenant.id, () =>
      buildQueue({ userId: auth.user.id, senderFirstName: auth.user.name.split(' ')[0], limit: 40 })
    )

    return NextResponse.json({
      ok: true,
      pacing,
      // Only what the panel renders. No emails, no scores of other people, no
      // account data — an extension surface should carry the minimum.
      cards: cards.map((c) => ({
        taskId: c.taskId,
        action: c.action,
        name: c.name,
        title: c.title,
        company: c.company,
        profileUrl: c.profileUrl,
        text: c.draft.text,
        limit: c.draft.limit,
        generic: c.draft.generic,
      })),
    })
  } catch (err) {
    logger.error({ err }, 'extension queue fetch failed')
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}

const outcomeSchema = z.object({
  taskId: z.string().min(1),
  outcome: z.enum(['sent', 'skipped', 'already_connected', 'not_a_fit']),
  finalText: z.string().max(8000).optional(),
})

export async function POST(req: NextRequest) {
  let auth
  try {
    auth = await requireAuth()
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'signed_out' }, { status: 401 })
    }
    throw err
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }

  const parsed = outcomeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'bad_payload' }, { status: 400 })
  }
  const d = parsed.data

  try {
    await withTenant(auth.tenant.id, async () => {
      // findUnique, not findUniqueOrThrow: an id that does not exist is the
      // caller's mistake, and letting Prisma's P2025 escape turns a 404 into a
      // 500 with a stack trace in the log. Note that RLS is what makes this a
      // genuine 404 for another tenant's id rather than a leak.
      const task = await db().task.findUnique({ where: { id: d.taskId } })
      if (!task) throw new Error('unknown_card')

      // A card belongs to one rep. The extension runs in the user's browser, but
      // that is not a reason to trust the id it sends.
      if (task.assigneeId && task.assigneeId !== auth.user.id) {
        throw new Error('not_your_card')
      }
      if (task.status !== 'open') throw new Error('already_recorded')

      const action = ((task.payload as { stepType?: string } | null)?.stepType ?? 'linkedin_connect')
        .replace('linkedin_', '') as LinkedInActionType

      if (d.outcome === 'sent') {
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const doneToday = await db().task.count({
          where: {
            type: 'linkedin', assigneeId: auth.user.id, status: 'completed',
            outcome: 'sent', completedAt: { gte: startOfDay },
          },
        })
        // Enforced here as well as in the UI: a cap that only exists client-side
        // is a suggestion, and this endpoint is callable directly.
        if (!assessPacing(action, doneToday).allowed) throw new Error('daily_ceiling')
        if (d.finalText && !withinLimit(action, d.finalText)) throw new Error('too_long')
      }

      await recordAction({
        taskId: d.taskId,
        actorId: auth.user.id,
        outcome: d.outcome,
        finalText: d.finalText,
      })
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'server_error'
    if (message === 'unknown_card') {
      return NextResponse.json({ ok: false, error: message }, { status: 404 })
    }
    const conflicts = ['not_your_card', 'already_recorded', 'daily_ceiling', 'too_long']
    if (conflicts.includes(message)) {
      return NextResponse.json({ ok: false, error: message }, { status: 409 })
    }
    logger.error({ err }, 'extension outcome record failed')
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
