/**
 * Fills the guide workspace's inbox with a realistic mix, so the layout can be
 * looked at rather than imagined.
 *
 * The mix matters: a screen with three tidy replies proves nothing about a mailbox
 * that also receives job alerts, digests and a delivery failure — which is the
 * state the inbox was actually redesigned for.
 */

import { prismaAdmin } from '../src/lib/db'
import { ingestInbound } from '../src/lib/email/receive'

async function main() {
  const tenant = await prismaAdmin.tenant.findFirstOrThrow({ where: { slug: 'acme' } })
  const contacts = await prismaAdmin.contact.findMany({
    where: { tenantId: tenant.id, email: { not: null } },
    take: 8,
    orderBy: { createdAt: 'asc' },
  })
  const mailbox = await prismaAdmin.mailbox.findFirst({ where: { tenantId: tenant.id } })
  const to = mailbox?.email ?? 'parthiv@acme.test'

  const replies = [
    'Yes — interested. Can you send pricing and a couple of references?',
    'Thanks, but we are all set for this year. Try me again in Q1.',
    'I am out of the office until 12 August with limited access to email.',
    'Wrong person — you want Priya, she owns this now.',
    'Please take me off your list.',
    'Sounds interesting. What does it cost for a team of 15?',
  ]

  let n = 0
  for (const [i, c] of contacts.entries()) {
    const body = replies[i % replies.length]
    await ingestInbound(tenant.id, {
      messageId: `<seed-reply-${i}-${process.pid}@prospect.test>`,
      fromEmail: c.email!,
      toEmail: to,
      subject: `Re: Quick question, ${c.firstName ?? 'there'}`,
      bodyText: body,
      receivedAt: new Date(Date.now() - (i + 1) * 3_600_000),
    })
    n++
  }

  // The noise. Each of these used to be counted as a reply.
  const noise: { from: string; subject: string; body: string; headers: Record<string, string> }[] = [
    {
      from: 'jobalerts-noreply@linkedin.com',
      subject: '“Founder” and 9 other jobs for you',
      body: 'See the latest jobs matching your profile in Toronto.',
      headers: { 'list-unsubscribe': '<https://www.linkedin.com/e/unsub>' },
    },
    {
      from: 'messages-noreply@linkedin.com',
      subject: 'You have 3 new invitations',
      body: 'People are waiting to connect with you.',
      headers: { 'list-unsubscribe': '<https://www.linkedin.com/e/unsub>' },
    },
    {
      from: 'newsletter@saasweekly.test',
      subject: 'SaaS Weekly — 40 tools you already forgot about',
      body: 'This week: pricing pages, churn, and a chart nobody asked for.',
      headers: { 'list-id': '<saasweekly.test>', precedence: 'bulk' },
    },
    {
      from: 'billing@somevendor.test',
      subject: 'Your invoice for July is ready',
      body: 'Invoice 2026-07 is attached.',
      headers: { 'feedback-id': 'inv:somevendor' },
    },
    {
      from: 'updates@producthunt.test',
      subject: 'Today’s top products',
      body: 'The 10 products the internet liked most today.',
      headers: { 'list-unsubscribe': '<https://producthunt.test/u>' },
    },
  ]

  for (const [i, m] of noise.entries()) {
    await ingestInbound(tenant.id, {
      messageId: `<seed-noise-${i}-${process.pid}@bulk.test>`,
      fromEmail: m.from,
      toEmail: to,
      subject: m.subject,
      bodyText: m.body,
      headers: m.headers,
      receivedAt: new Date(Date.now() - (i + 1) * 5_400_000),
    })
    n++
  }

  console.log(`Seeded ${n} inbound messages into ${tenant.name}.`)
  await prismaAdmin.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
