import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { prismaAdmin, withTenant, db, tid } from '@/lib/db'
import { normalizeEmail, domainFromEmail } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { redis } from '@/lib/queue'

/**
 * Public lead-capture endpoint. Unauthenticated by design — it is embedded in
 * customers' marketing pages.
 *
 * Because it is public it is also the most attackable surface in the product,
 * so it is deliberately narrow:
 *   - the publicKey identifies the form and therefore the tenant; nothing else
 *     about the tenant is accepted from the request;
 *   - the payload is whitelisted, so no field can be smuggled in;
 *   - it is rate-limited per key and per IP;
 *   - the response never reveals whether a contact already existed, which would
 *     turn this into an email-enumeration oracle.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const payload = z.object({
  email: z.string().email().max(254),
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(60).optional(),
  message: z.string().trim().max(2000).optional(),
  // Honeypot: bots fill hidden fields, humans do not. Deliberately permissive —
  // validating it here would return 400 and tell the bot it was detected. The
  // handler checks it after validation and accepts silently instead.
  _hp: z.string().max(500).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
})

const RATE = { windowSec: 60, maxPerKey: 60, maxPerIp: 10 }

async function rateLimited(bucket: string, max: number): Promise<boolean> {
  try {
    const n = await redis.incr(bucket)
    if (n === 1) await redis.expire(bucket, RATE.windowSec)
    return n > max
  } catch (err) {
    // A Redis outage must not take lead capture offline; fail open and log.
    logger.warn({ err }, 'rate limiter unavailable; allowing request')
    return false
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  if (
    (await rateLimited(`rl:capture:key:${key}`, RATE.maxPerKey)) ||
    (await rateLimited(`rl:capture:ip:${ip}`, RATE.maxPerIp))
  ) {
    return NextResponse.json(
      { ok: false, error: 'Too many submissions. Please try again shortly.' },
      { status: 429, headers: CORS }
    )
  }

  // The one pre-tenant lookup: resolve the form, and with it the tenant.
  const form = await prismaAdmin.captureForm.findUnique({
    where: { publicKey: key },
    include: { tenant: { select: { id: true, status: true } } },
  })

  if (!form || !form.active || form.tenant.status !== 'active') {
    return NextResponse.json({ ok: false, error: 'Form not found.' }, { status: 404, headers: CORS })
  }

  let body: unknown
  try {
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      body = await req.json()
    } else {
      const fd = await req.formData()
      body = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request body.' }, { status: 400, headers: CORS })
  }

  const parsed = payload.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid submission.' },
      { status: 400, headers: CORS }
    )
  }

  const data = parsed.data

  // Honeypot tripped — accept silently so the bot does not learn anything.
  if (data._hp) {
    logger.debug({ key, ip }, 'capture honeypot tripped')
    return NextResponse.json({ ok: true }, { status: 202, headers: CORS })
  }

  const email = normalizeEmail(data.email)

  try {
    await withTenant(form.tenant.id, async () => {
      // Respect suppression: a form fill from a suppressed address is recorded
      // as a lead but must not resurrect them into outreach.
      const suppressed = await db().suppressionEntry.findFirst({
        where: {
          OR: [
            { type: 'email', value: email },
            { type: 'domain', value: domainFromEmail(email) ?? '__none__' },
          ],
        },
        select: { id: true },
      })

      const assignee = await resolveAssignee(form.assignRule as Record<string, unknown>)

      await db().lead.create({
        data: {
          tenantId: tid(),
          email,
          firstName: data.firstName,
          lastName: data.lastName,
          company: data.company,
          title: data.title,
          phone: data.phone,
          message: data.message,
          source: 'form',
          sourceMeta: {
            formId: form.id,
            formName: form.name,
            utm: data.utm ?? {},
            ip,
            userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
            suppressed: Boolean(suppressed),
          },
          ownerId: assignee,
        },
      })

      await db().captureForm.update({
        where: { id: form.id },
        data: { submissions: { increment: 1 } },
      })
    })
  } catch (err) {
    logger.error({ err, key }, 'capture submission failed')
    return NextResponse.json(
      { ok: false, error: 'Could not record the submission.' },
      { status: 500, headers: CORS }
    )
  }

  // Deliberately identical whether or not this email was already known.
  return NextResponse.json(
    { ok: true, redirect: form.redirectUrl ?? null },
    { status: 201, headers: CORS }
  )
}

/**
 * Assignment rules. Round-robin is stateless here — it picks the active rep
 * with the fewest open leads, which self-balances and survives restarts better
 * than a stored cursor.
 */
async function resolveAssignee(rule: Record<string, unknown>): Promise<string | null> {
  const kind = typeof rule?.kind === 'string' ? rule.kind : 'unassigned'

  if (kind === 'fixed' && typeof rule.userId === 'string') {
    const user = await db().user.findFirst({
      where: { id: rule.userId, status: 'active' },
      select: { id: true },
    })
    return user?.id ?? null
  }

  if (kind === 'round_robin') {
    const reps = await db().user.findMany({
      where: { status: 'active', role: { in: ['rep', 'manager'] } },
      select: { id: true, _count: { select: { ownedLeads: true } } },
    })
    if (!reps.length) return null
    return reps.sort((a, b) => a._count.ownedLeads - b._count.ownedLeads)[0].id
  }

  return null
}
