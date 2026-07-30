import 'dotenv/config'
import { prismaAdmin, withTenant, db, tid, disconnect } from '../src/lib/db'
import { processEnrollmentStep, enrollContacts, recordReply } from '../src/worker/jobs/sequence'
import { warmupCap } from '../src/lib/email/schedule'

/**
 * Phase 3 demo data for the `acme` tenant: a warmed mailbox, two templates, a
 * three-step sequence, and a handful of enrollments actually driven through the
 * engine so the UI shows real sends, opens and replies.
 *
 * EMAIL_TRANSPORT must be 'log' — this deliberately never sends real email.
 *
 *   npx tsx scripts/seed-sequences.ts
 */

const STEP_1 = `Hi {{first_name | there}},

I noticed {{company}} has been adding to the team this year. At that stage the usual bottleneck isn't headcount, it's that nobody owns the handoff between systems — so work quietly piles up in someone's inbox.

Is that roughly what you're seeing, or have you already solved it?

{{sender_first_name}}`

const STEP_2 = `Hi {{first_name | there}},

Following up on the note above. One thing that surprised me: most teams your size lose more time to duplicate data entry than to actually selling.

If that resonates, happy to walk through how three other {{industry | B2B}} teams handled it. If not, I'll stop here.

{{sender_first_name}}`

const STEP_3 = `{{first_name | Hi}} — closing the loop on this.

If the timing is wrong, no problem at all. If you'd like me to check back next quarter instead, just say the word.

{{sender_first_name}}`

async function main() {
  if (process.env.EMAIL_TRANSPORT !== 'log') {
    console.error(
      'Refusing to run: set EMAIL_TRANSPORT=log first. This script drives the real engine ' +
        'and would otherwise send actual email to the seeded addresses.'
    )
    process.exit(1)
  }

  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  const rep = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'rohan@acme.test' },
  })

  const { sequenceId, enrolled } = await withTenant(
    tenant.id,
    async () => {
      // --- mailbox ---------------------------------------------------------
      const existingMailbox = await db().mailbox.findFirst({ where: { email: 'rohan@acme-outbound.test' } })
      const mailbox =
        existingMailbox ??
        (await db().mailbox.create({
          data: {
            tenantId: tid(),
            provider: 'ses',
            email: 'rohan@acme-outbound.test',
            fromName: 'Rohan Desai',
            userId: rep.id,
            // Presented as a mailbox that has finished warming, so the demo shows
            // a steady-state cap rather than day-one throttling.
            health: 'healthy',
            warmupDay: 60,
            warmupTarget: 200,
            dailyCap: warmupCap(60, 200),
            spfOk: true,
            dkimOk: true,
            dmarcOk: true,
            lastCheckedAt: new Date(),
          },
        }))

      // --- templates -------------------------------------------------------
      for (const t of [
        { name: 'Logistics — first touch', subject: 'Question about {{company}} handoffs', bodyText: STEP_1 },
        { name: 'Logistics — bump', subject: 'Re: {{company}}', bodyText: STEP_2 },
      ]) {
        const existing = await db().emailTemplate.findFirst({ where: { name: t.name } })
        if (!existing) {
          await db().emailTemplate.create({
            data: { tenantId: tid(), ...t, bodyHtml: '', createdById: rep.id },
          })
        }
      }

      // --- sequence --------------------------------------------------------
      const existingSeq = await db().sequence.findFirst({ where: { name: 'Q3 logistics outbound' } })
      const sequence =
        existingSeq ??
        (await db().sequence.create({
          data: {
            tenantId: tid(),
            name: 'Q3 logistics outbound',
            description: 'Three touches over eight days, weekdays only, stops on any reply.',
            status: 'active',
            sendWindowStart: 9,
            sendWindowEnd: 17,
            sendDays: [1, 2, 3, 4, 5],
            stopOnReply: true,
            stopOnAccountReply: true,
            trackOpens: false,
            trackClicks: false,
            createdById: rep.id,
          },
        }))

      await db().sequence.update({ where: { id: sequence.id }, data: { status: 'active' } })

      const stepCount = await db().sequenceStep.count({ where: { sequenceId: sequence.id } })
      if (stepCount === 0) {
        await db().sequenceStep.createMany({
          data: [
            {
              sequenceId: sequence.id, order: 1, type: 'email', delayMinutes: 0,
              subject: 'Question about {{company}} handoffs', bodyText: STEP_1,
            },
            {
              sequenceId: sequence.id, order: 2, type: 'email', delayMinutes: 3 * 24 * 60,
              subject: 'Re: {{company}}', bodyText: STEP_2,
              conditions: { type: 'if_no_reply' },
            },
            {
              sequenceId: sequence.id, order: 3, type: 'linkedin_connect',
              delayMinutes: 2 * 24 * 60,
              taskNote: 'Send a connection request referencing the emails — you send it, not us.',
              bodyText: 'Hi {{first_name}}, sent you a note about {{company}} handoffs. Worth connecting either way.',
              conditions: { type: 'if_no_reply' },
            },
            {
              sequenceId: sequence.id, order: 4, type: 'email', delayMinutes: 3 * 24 * 60,
              subject: 'Closing the loop', bodyText: STEP_3,
              conditions: { type: 'if_no_reply' },
            },
          ],
        })
      }

      // --- who to enrol ----------------------------------------------------
      const contacts = await db().contact.findMany({
        where: {
          email: { not: null },
          unsubscribedAt: null,
          bouncedAt: null,
          status: { not: 'do_not_contact' },
          score: { gte: 40 },
        },
        select: { id: true },
        take: 8,
      })

      return { sequenceId: sequence.id, enrolled: contacts.map((c) => c.id), mailboxId: mailbox.id }
    },
    { timeout: 120_000 }
  )

  if (!enrolled.length) {
    console.log('No eligible contacts found — run `npm run db:seed-demo` first.')
    return
  }

  const enrolment = await enrollContacts({
    tenantId: tenant.id,
    sequenceId,
    contactIds: enrolled,
    enrolledById: rep.id,
  })
  console.log(`Enrolled ${enrolment.enrolled}, skipped ${enrolment.skipped}`)

  // Drive step 1 for everyone so the sequence has real send history.
  const enrollments = await prismaAdmin.sequenceEnrollment.findMany({
    where: { tenantId: tenant.id, sequenceId, status: 'active' },
    select: { id: true, contactId: true },
  })

  await prismaAdmin.sequenceEnrollment.updateMany({
    where: { id: { in: enrollments.map((e) => e.id) } },
    data: { nextRunAt: new Date() },
  })

  let sent = 0
  for (const e of enrollments) {
    const r = (await processEnrollmentStep({ enrollmentId: e.id, tenantId: tenant.id })) as {
      sent?: boolean
    }
    if (r?.sent) sent++
  }
  console.log(`Step 1 sent for ${sent} contacts`)

  // Two of them reply, which must stop their sequences.
  for (const e of enrollments.slice(0, 2)) {
    await recordReply({
      tenantId: tenant.id,
      contactId: e.contactId,
      subject: 'Re: Question about handoffs',
      bodyText:
        'That does sound familiar — we lose a lot of time reconciling between systems. ' +
        'Can you send over some detail before we book something?',
    })
  }
  console.log('Recorded 2 replies (their sequences should now be stopped)')

  // A third opens the email a couple of times, so engagement is not all-or-nothing.
  const opener = enrollments[2]
  if (opener) {
    await withTenant(tenant.id, async () => {
      const msg = await db().emailMessage.findFirst({
        where: { contactId: opener.contactId, direction: 'outbound' },
        orderBy: { createdAt: 'desc' },
      })
      if (msg) {
        await db().emailMessage.update({
          where: { id: msg.id },
          data: { status: 'opened', opensCount: 2, openedAt: new Date(), deliveredAt: new Date() },
        })
        await db().activity.create({
          data: {
            tenantId: tid(), type: 'email_opened', summary: 'Opened an email',
            contactId: opener.contactId,
          },
        })
      }
    })
  }

  const [messages, active, stopped] = await Promise.all([
    prismaAdmin.emailMessage.count({ where: { tenantId: tenant.id, direction: 'outbound' } }),
    prismaAdmin.sequenceEnrollment.count({ where: { tenantId: tenant.id, status: 'active' } }),
    prismaAdmin.sequenceEnrollment.count({
      where: { tenantId: tenant.id, status: 'stopped_replied' },
    }),
  ])

  console.log(
    `Done: ${messages} outbound messages, ${active} active enrollments, ${stopped} stopped on reply`
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  // Closes both the runtime and owner clients; closing only one leaves the
  // process alive with an open pool and the script appears to hang.
  .finally(() => disconnect())
