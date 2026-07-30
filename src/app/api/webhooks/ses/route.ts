import { NextResponse, type NextRequest } from 'next/server'
import { prismaAdmin, withTenant, db, tid } from '@/lib/db'
import { logger } from '@/lib/logger'
import { assessReputation } from '@/lib/email/deliverability'
import { domainFromEmail } from '@/lib/utils'

/**
 * SES event notifications, delivered via SNS.
 *
 * Bounces and complaints are the events that decide whether the sending domain
 * survives, so they do three things rather than one:
 *   1. mark the message,
 *   2. suppress the address so nothing else ever sends to it,
 *   3. re-assess the mailbox and pause it if reputation has degraded.
 *
 * Suppression is the important one. AWS suspends accounts over 5% bounce; the
 * only reliable way to stay under is to never retry a known-bad address.
 */

type SnsEnvelope = {
  Type?: string
  Message?: string
  SubscribeURL?: string
  TopicArn?: string
}

type SesEvent = {
  eventType?: string
  notificationType?: string
  mail?: {
    messageId?: string
    destination?: string[]
    commonHeaders?: { subject?: string }
  }
  bounce?: {
    bounceType?: string
    bounceSubType?: string
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[]
  }
  complaint?: {
    complainedRecipients?: { emailAddress?: string }[]
    complaintFeedbackType?: string
  }
  delivery?: { recipients?: string[] }
  open?: { ipAddress?: string }
  click?: { link?: string }
}

export async function POST(req: NextRequest) {
  const raw = await req.text()

  let envelope: SnsEnvelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 })
  }

  // SNS subscription handshake. We log the URL rather than auto-confirming:
  // auto-confirming would let anyone point an SNS topic at this endpoint.
  if (envelope.Type === 'SubscriptionConfirmation') {
    logger.warn(
      { subscribeUrl: envelope.SubscribeURL, topicArn: envelope.TopicArn },
      'SNS subscription confirmation received — confirm manually after verifying the topic ARN'
    )
    return NextResponse.json({ ok: true, action: 'manual_confirmation_required' })
  }

  if (envelope.Type === 'UnsubscribeConfirmation') {
    return NextResponse.json({ ok: true })
  }

  let event: SesEvent
  try {
    event = JSON.parse(envelope.Message ?? raw)
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid SES message.' }, { status: 400 })
  }

  const providerId = event.mail?.messageId
  if (!providerId) return NextResponse.json({ ok: true, skipped: 'no_message_id' })

  const message = await prismaAdmin.emailMessage.findFirst({
    where: { providerId },
    select: { id: true, tenantId: true, contactId: true, mailboxId: true, toEmail: true },
  })

  if (!message) {
    logger.debug({ providerId }, 'SES event for an unknown message')
    return NextResponse.json({ ok: true, skipped: 'unknown_message' })
  }

  const type = (event.eventType ?? event.notificationType ?? '').toLowerCase()

  try {
    await withTenant(message.tenantId, async () => {
      await db().emailEvent.create({
        data: { messageId: message.id, type: type || 'unknown', payload: event as never },
      })

      switch (type) {
        case 'delivery':
          await db().emailMessage.update({
            where: { id: message.id },
            data: { status: 'delivered', deliveredAt: new Date() },
          })
          break

        case 'bounce': {
          const hard = event.bounce?.bounceType === 'Permanent'
          const diagnostic =
            event.bounce?.bouncedRecipients?.[0]?.diagnosticCode ??
            `${event.bounce?.bounceType}/${event.bounce?.bounceSubType}`

          await db().emailMessage.update({
            where: { id: message.id },
            data: { status: 'bounced', bouncedAt: new Date(), error: diagnostic?.slice(0, 500) },
          })

          // Only permanent bounces suppress. A full mailbox or an out-of-office
          // auto-reply is transient, and suppressing on those loses real leads.
          if (hard) {
            await suppress(message.tenantId, message.toEmail, 'bounce')

            if (message.contactId) {
              await db().contact.update({
                where: { id: message.contactId },
                data: { bouncedAt: new Date(), emailStatus: 'invalid' },
              })
              await db().sequenceEnrollment.updateMany({
                where: { contactId: message.contactId, status: 'active' },
                data: {
                  status: 'stopped_bounced',
                  stoppedAt: new Date(),
                  stopReason: 'Email bounced',
                  nextRunAt: null,
                },
              })
            }
          }

          if (message.mailboxId) await reassess(message.mailboxId)
          break
        }

        case 'complaint': {
          await db().emailMessage.update({
            where: { id: message.id },
            data: { status: 'complained' },
          })

          // A complaint is a spam-button press. Always suppress, always stop.
          await suppress(message.tenantId, message.toEmail, 'complaint')

          if (message.contactId) {
            await db().contact.update({
              where: { id: message.contactId },
              data: { unsubscribedAt: new Date(), status: 'do_not_contact' },
            })
            await db().sequenceEnrollment.updateMany({
              where: { contactId: message.contactId, status: 'active' },
              data: {
                status: 'stopped_unsubscribed',
                stoppedAt: new Date(),
                stopReason: 'Spam complaint',
                nextRunAt: null,
              },
            })
          }

          if (message.mailboxId) await reassess(message.mailboxId)
          break
        }

        case 'open':
          await db().emailMessage.update({
            where: { id: message.id },
            data: { opensCount: { increment: 1 }, openedAt: new Date() },
          })
          break

        case 'click':
          await db().emailMessage.update({
            where: { id: message.id },
            data: { clicksCount: { increment: 1 }, clickedAt: new Date() },
          })
          break

        case 'reject':
          await db().emailMessage.update({
            where: { id: message.id },
            data: { status: 'failed', failedAt: new Date(), error: 'Rejected by SES' },
          })
          break
      }
    })
  } catch (err) {
    logger.error({ err, providerId, type }, 'failed to process SES event')
    // 500 so SNS retries; losing a bounce notification is how reputation dies.
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  return NextResponse.json({ ok: true, type })
}

async function suppress(tenantId: string, email: string, reason: string) {
  await db().suppressionEntry.upsert({
    where: { tenantId_type_value: { tenantId, type: 'email', value: email } },
    update: {},
    create: { tenantId: tid(), type: 'email', value: email, reason },
  })
}

/**
 * Recomputes bounce and complaint rates for a mailbox and throttles it if the
 * numbers have gone bad. Pausing our own sending is always cheaper than having
 * AWS pause the account.
 */
async function reassess(mailboxId: string) {
  const [sent, bounced, complained] = await Promise.all([
    db().emailMessage.count({ where: { mailboxId, direction: 'outbound', sentAt: { not: null } } }),
    db().emailMessage.count({ where: { mailboxId, status: 'bounced' } }),
    db().emailMessage.count({ where: { mailboxId, status: 'complained' } }),
  ])

  const verdict = assessReputation({ sent, bounced, complained })
  const bounceRate = sent ? bounced / sent : 0
  const complaintRate = sent ? complained / sent : 0

  await db().mailbox.update({
    where: { id: mailboxId },
    data: {
      bounceRate,
      complaintRate,
      ...(verdict.action === 'pause' ? { health: 'throttled' as const } : {}),
    },
  })

  if (verdict.action !== 'ok') {
    logger.warn({ mailboxId, verdict, sent, bounced, complained }, 'mailbox reputation degraded')
  }
}

/** SNS sends a GET when a human opens the endpoint URL; make that harmless. */
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'ses-events' })
}
