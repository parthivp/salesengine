import { NextResponse, type NextRequest } from 'next/server'
import { prismaAdmin, withTenant, db } from '@/lib/db'
import { verifyToken } from '@/lib/email/send'
import { logger } from '@/lib/logger'

/**
 * Open tracking pixel.
 *
 * Always returns the GIF, whatever happens — a broken image in a prospect's
 * inbox is worse than a missed metric.
 *
 * Opens are the least trustworthy signal in email: Apple Mail Privacy Protection
 * and Gmail's proxy pre-fetch images, so a recorded open may be a machine. That
 * is why scoring weights a reply at 40 and a repeat open at 10, and why open
 * tracking is off by default per sequence.
 */

// 1x1 transparent GIF
const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

function pixel() {
  return new NextResponse(GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(GIF.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
    },
  })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string; token: string }> }
) {
  const { messageId: raw, token } = await params
  const messageId = raw.replace(/\.gif$/, '')
  const cleanToken = token.replace(/\.gif$/, '')

  try {
    if (!verifyToken(`o:${messageId}`, cleanToken)) return pixel()

    const message = await prismaAdmin.emailMessage.findUnique({
      where: { id: messageId },
      select: { id: true, tenantId: true, contactId: true, status: true, openedAt: true },
    })
    if (!message) return pixel()

    const ua = req.headers.get('user-agent') ?? ''

    await withTenant(message.tenantId, async () => {
      await db().emailMessage.update({
        where: { id: message.id },
        data: {
          opensCount: { increment: 1 },
          openedAt: message.openedAt ?? new Date(),
          // Never downgrade a later status: a replied email that gets re-opened
          // by a mail client must not revert to 'opened'.
          ...(message.status === 'sent' || message.status === 'delivered'
            ? { status: 'opened' as const }
            : {}),
        },
      })

      await db().emailEvent.create({
        data: { messageId: message.id, type: 'open', payload: { userAgent: ua.slice(0, 300) } },
      })

      if (message.contactId && !message.openedAt) {
        await db().activity.create({
          data: {
            tenantId: message.tenantId,
            type: 'email_opened',
            summary: 'Opened an email',
            contactId: message.contactId,
          },
        })
      }
    })
  } catch (err) {
    logger.warn({ err }, 'open tracking failed')
  }

  return pixel()
}
