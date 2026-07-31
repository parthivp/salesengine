import 'dotenv/config'
import { prismaAdmin, withTenant, db, disconnect } from '../src/lib/db'
import { ingestInbound, isReply, type InboundMessage } from '../src/lib/email/receive'

/**
 * Seeds the inbox by pushing messages through the real ingestion path.
 *
 * Not by inserting rows: the point is to exercise threading, classification and
 * the resulting actions exactly as an IMAP poll would, so what the screen shows is
 * what the pipeline actually produces rather than what a fixture claims.
 */

type Case = {
  to: string
  subject: string
  body: string
  headers?: Record<string, string>
  note: string
}

const CASES: Case[] = [
  {
    to: 'sofia',
    subject: 'Re: Quick question, Sofia',
    body: "Yes — interested. What does it cost for a team of 30? Happy to jump on a call Thursday.\n\nSofia",
    note: 'the one you want: stops the sequence, files an urgent task',
  },
  {
    to: 'felix',
    subject: 'Automatic reply: Following up',
    body:
      'I am out of the office until 14 August with limited access to email.\n' +
      'For anything urgent please contact ops@orbitalcast.test.',
    headers: { 'auto-submitted': 'auto-replied' },
    note: 'must NOT stop the sequence — holds it until the 14th instead',
  },
  {
    to: 'marcus',
    subject: 'Re: Following up',
    body: 'Not interested, thanks. We already have a tool for this.',
    note: 'stops the sequence, marks unqualified, files no task',
  },
  {
    to: 'clara',
    subject: 'Re: Quick question, Clara',
    body: "Wrong person — I don't handle this. You want to speak to Ana in RevOps.",
    note: 'stops, files a task to find the right person',
  },
  {
    to: 'omar',
    subject: 'Re: Following up',
    body: 'Please take me off your list and delete my details.',
    note: 'suppresses the address, stops as unsubscribed',
  },
  {
    to: 'daniel',
    subject: 'Re: Quick question',
    body: 'Not right now, but send me pricing for next quarter.',
    note: 'conflicting signals — routed to a human rather than guessed',
  },
]

async function main() {
  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })

  await withTenant(
    tenant.id,
    async () => {
      const mailbox = await db().mailbox.findFirst()
      if (!mailbox) throw new Error('No mailbox seeded — run db:seed-sequences first.')

      for (const c of CASES) {
        const contact = await db().contact.findFirst({
          where: { firstName: { equals: c.to, mode: 'insensitive' } },
        })
        if (!contact?.email) {
          console.log(`  skip ${c.to}: no contact with an email`)
          continue
        }

        // Give them an outbound to reply to, so threading has something to find.
        let parent = await db().emailMessage.findFirst({
          where: { contactId: contact.id, direction: 'outbound' },
          orderBy: { sentAt: 'desc' },
        })
        if (!parent) {
          parent = await db().emailMessage.create({
            data: {
              tenantId: tenant.id,
              direction: 'outbound',
              status: 'sent',
              contactId: contact.id,
              mailboxId: mailbox.id,
              fromEmail: mailbox.email,
              toEmail: contact.email,
              subject: c.subject.replace(/^Re:\s*|^Automatic reply:\s*/i, ''),
              bodyText: 'Seeded outbound so the reply has a thread to attach to.',
              messageId: `<seed-out-${contact.id}@salesengine.local>`,
              sentAt: new Date(Date.now() - 2 * 86_400_000),
            },
          })
        }

        const msg: InboundMessage = {
          messageId: `<seed-in-${contact.id}-${c.subject.length}@prospect.test>`,
          inReplyTo: parent.messageId,
          fromEmail: contact.email,
          toEmail: mailbox.email,
          subject: c.subject,
          bodyText: c.body,
          receivedAt: new Date(Date.now() - Math.random() * 0), // stamped below
          headers: c.headers,
        }
        // Deterministic ordering without Math.random: stagger by index.
        msg.receivedAt = new Date(Date.now() - CASES.indexOf(c) * 3_600_000)

        const r = await ingestInbound(tenant.id, msg)
        if (isReply(r)) {
          console.log(
            `  ${contact.firstName}: ${r.classification.intent} ` +
              `(${Math.round(r.classification.confidence * 100)}%) — ${r.actions.join(', ')}`
          )
        } else if (!r.ok) {
          console.log(`  ${contact.firstName}: not ingested (${r.reason})`)
        }
      }

      // One reply from somebody who is not in the database, to show that unmatched
      // mail is kept rather than dropped.
      const stray = await ingestInbound(tenant.id, {
        messageId: `<seed-stray-${tenant.id}@elsewhere.test>`,
        fromEmail: 'procurement@unknown-co.test',
        toEmail: mailbox.email,
        subject: 'Re: your email',
        bodyText: 'Who is this? How did you get my address?',
        receivedAt: new Date(Date.now() - 7 * 3_600_000),
      })
      console.log(`  stray: ${stray.ok ? 'ingested' : stray.reason}`)
    },
    { timeout: 120_000 }
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => disconnect())
