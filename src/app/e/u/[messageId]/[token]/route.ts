import { NextResponse, type NextRequest } from 'next/server'
import { prismaAdmin, withTenant, db, tid } from '@/lib/db'
import { verifyToken } from '@/lib/email/send'
import { domainFromEmail } from '@/lib/utils'
import { logger } from '@/lib/logger'

/**
 * Unsubscribe.
 *
 * Signed URLs, because an unauthenticated endpoint keyed on a guessable id would
 * let anyone unsubscribe anyone. The signature covers the message id.
 *
 * GET renders a confirmation page; POST performs it. Both are supported because
 * Gmail's one-click unsubscribe issues a POST, while a human clicking the link in
 * the footer issues a GET — and some scanners pre-fetch GETs, so a GET must not
 * silently unsubscribe someone who never clicked.
 */

async function resolve(messageId: string, token: string) {
  if (!verifyToken(`u:${messageId}`, token)) return null

  const message = await prismaAdmin.emailMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true, tenantId: true, contactId: true, toEmail: true,
      tenant: { select: { name: true } },
    },
  })
  return message
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ messageId: string; token: string }> }
) {
  const { messageId, token } = await params
  const message = await resolve(messageId, token)

  if (!message) {
    return html(
      `<h1>Link not recognised</h1><p>This unsubscribe link is invalid or has expired.</p>`,
      404
    )
  }

  const already = await withTenant(message.tenantId, () =>
    db().suppressionEntry.findFirst({ where: { type: 'email', value: message.toEmail } })
  )

  if (already) {
    return html(
      `<h1>You're unsubscribed</h1>
       <p><strong>${escape(message.toEmail)}</strong> has already been removed from ${escape(
         message.tenant.name
       )}'s mailing list. You will not receive further emails.</p>`
    )
  }

  return html(
    `<h1>Unsubscribe</h1>
     <p>Confirm you no longer want emails from ${escape(message.tenant.name)} at
     <strong>${escape(message.toEmail)}</strong>.</p>
     <form method="post">
       <button type="submit">Unsubscribe me</button>
     </form>
     <p class="muted">This takes effect immediately and stops every active sequence.</p>`
  )
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string; token: string }> }
) {
  const { messageId, token } = await params
  const message = await resolve(messageId, token)

  if (!message) {
    return NextResponse.json({ ok: false, error: 'Invalid link.' }, { status: 404 })
  }

  try {
    await withTenant(message.tenantId, async () => {
      await db().suppressionEntry.upsert({
        where: {
          tenantId_type_value: {
            tenantId: message.tenantId,
            type: 'email',
            value: message.toEmail,
          },
        },
        update: {},
        create: {
          tenantId: tid(),
          type: 'email',
          value: message.toEmail,
          reason: 'unsubscribe',
        },
      })

      if (message.contactId) {
        await db().contact.update({
          where: { id: message.contactId },
          data: { unsubscribedAt: new Date(), status: 'do_not_contact' },
        })

        // Stop every sequence, not just the one that sent this email. A person
        // who unsubscribes means all of it.
        await db().sequenceEnrollment.updateMany({
          where: { contactId: message.contactId, status: 'active' },
          data: {
            status: 'stopped_unsubscribed',
            stoppedAt: new Date(),
            stopReason: 'Unsubscribed',
            nextRunAt: null,
          },
        })

        await db().activity.create({
          data: {
            tenantId: tid(),
            type: 'field_change',
            summary: 'Unsubscribed',
            contactId: message.contactId,
          },
        })
      }
    })
  } catch (err) {
    logger.error({ err, messageId }, 'unsubscribe failed')
    return NextResponse.json({ ok: false, error: 'Could not process that.' }, { status: 500 })
  }

  // Gmail's one-click POST wants a 2xx, not a redirect.
  const wantsJson = req.headers.get('accept')?.includes('application/json')
  if (wantsJson) return NextResponse.json({ ok: true })

  return html(
    `<h1>You're unsubscribed</h1>
     <p><strong>${escape(message.toEmail)}</strong> has been removed from ${escape(
       message.tenant.name
     )}'s list. Any active sequences have been stopped.</p>`
  )
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function html(body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Unsubscribe</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;max-width:440px}
  h1{font-size:20px;margin:0 0 12px}
  p{font-size:15px;line-height:1.55;margin:0 0 12px}
  .muted{color:#64748b;font-size:13px}
  button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 16px;
         font-size:14px;font-weight:500;cursor:pointer}
  button:hover{background:#1d4ed8}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}
