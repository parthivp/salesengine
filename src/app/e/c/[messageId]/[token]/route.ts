import { NextResponse, type NextRequest } from 'next/server'
import { prismaAdmin, withTenant, db } from '@/lib/db'
import { verifyToken } from '@/lib/email/send'
import { logger } from '@/lib/logger'

/**
 * Click tracking. Records the click, then redirects.
 *
 * The redirect target is carried in the signed payload rather than trusted from
 * the query string alone — an unsigned redirector is an open redirect, which is
 * both a phishing gift and a fast route onto blocklists.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string; token: string }> }
) {
  const { messageId, token } = await params
  const encoded = req.nextUrl.searchParams.get('u') ?? ''

  if (!verifyToken(`c:${messageId}:${encoded}`, token)) {
    return NextResponse.json({ error: 'Invalid link.' }, { status: 400 })
  }

  let target: string
  try {
    target = Buffer.from(encoded, 'base64url').toString('utf8')
    const url = new URL(target)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    return NextResponse.json({ error: 'Invalid link.' }, { status: 400 })
  }

  try {
    const message = await prismaAdmin.emailMessage.findUnique({
      where: { id: messageId },
      select: { id: true, tenantId: true, contactId: true, status: true, clickedAt: true },
    })

    if (message) {
      await withTenant(message.tenantId, async () => {
        await db().emailMessage.update({
          where: { id: message.id },
          data: {
            clicksCount: { increment: 1 },
            clickedAt: message.clickedAt ?? new Date(),
            ...(message.status === 'sent' || message.status === 'delivered' || message.status === 'opened'
              ? { status: 'clicked' as const }
              : {}),
          },
        })
        await db().emailEvent.create({
          data: { messageId: message.id, type: 'click', payload: { target } },
        })
        if (message.contactId && !message.clickedAt) {
          await db().activity.create({
            data: {
              tenantId: message.tenantId,
              type: 'email_opened',
              summary: `Clicked a link`,
              contactId: message.contactId,
              detail: { target },
            },
          })
        }
      })
    }
  } catch (err) {
    logger.warn({ err, messageId }, 'click tracking failed')
  }

  return NextResponse.redirect(target, { status: 302 })
}
