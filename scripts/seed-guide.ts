import { PrismaClient } from '@prisma/client'

/**
 * A believable workspace, for the screenshots in the how-to guide.
 *
 * Not a fixture and not test data: the guide is read by someone deciding what a
 * screen is for, and an empty state teaches nothing while obviously fake data
 * ("Acme Corp", "Test User") teaches the wrong thing. So this is one coherent
 * story — a legal-tech pipeline, mid-flight — with the numbers arranged so every
 * screen has something worth looking at: a queue with cards, a funnel with a real
 * drop-off, replies of each classification, and deals across the stages.
 *
 * Run with: npx tsx --env-file=.env scripts/seed-guide.ts
 */

const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_DATABASE_URL } } })

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY)
const soon = (d: number) => new Date(Date.now() + d * DAY)

const ACCOUNTS = [
  { name: 'Zhong Lun Law Firm', domain: 'zhonglun.com', industry: 'Legal services', employeeCount: 2500, country: 'China', city: 'Beijing' },
  { name: 'Executive Reporting Service', domain: 'executivereporting.com', industry: 'Legal services', employeeCount: 17, country: 'United States', city: 'Clearwater' },
  { name: 'Marlow & Finch LLP', domain: 'marlowfinch.co.uk', industry: 'Legal services', employeeCount: 240, country: 'United Kingdom', city: 'London' },
  { name: 'Caseflow', domain: 'caseflow.io', industry: 'Legal technology', employeeCount: 62, country: 'United Kingdom', city: 'Manchester' },
  { name: 'Verity Depositions', domain: 'veritydepo.com', industry: 'Legal services', employeeCount: 95, country: 'United States', city: 'Chicago' },
  { name: 'Halden Chambers', domain: 'haldenchambers.co.uk', industry: 'Legal services', employeeCount: 40, country: 'United Kingdom', city: 'Leeds' },
  { name: 'Northgate Legal Ops', domain: 'northgatelegal.com', industry: 'Legal technology', employeeCount: 310, country: 'United States', city: 'Austin' },
  { name: 'Brightline Counsel', domain: 'brightlinecounsel.com', industry: 'Legal services', employeeCount: 8, country: 'Ireland', city: 'Dublin' },
]

type Person = {
  first: string; last: string; title: string; account: string
  li?: string; email?: string
  invited?: number; connected?: number; replied?: number
  status?: 'new' | 'working' | 'engaged' | 'qualified'
  score?: number
}

const PEOPLE: Person[] = [
  { first: 'Borong', last: 'Liu', title: 'Partner', account: 'Zhong Lun Law Firm', li: 'borong-liu-40028888', email: 'liuborong@zhonglun.com', invited: 12, connected: 9, status: 'engaged', score: 74 },
  { first: 'Andrew', last: 'Mayes', title: 'Founder & Builder, DepoStack', account: 'Executive Reporting Service', li: 'mayesandrew', email: 'andrew@executivereporting.com', invited: 11, connected: 8, replied: 2, status: 'qualified', score: 88 },
  { first: 'Helena', last: 'Marlow', title: 'Managing Partner', account: 'Marlow & Finch LLP', li: 'helena-marlow', email: 'h.marlow@marlowfinch.co.uk', invited: 10, connected: 4, status: 'engaged', score: 81 },
  { first: 'Dev', last: 'Raghunathan', title: 'Head of Legal Operations', account: 'Northgate Legal Ops', li: 'devraghunathan', email: 'dev@northgatelegal.com', invited: 9, connected: 6, replied: 1, status: 'qualified', score: 92 },
  { first: 'Saoirse', last: 'Nolan', title: 'General Counsel', account: 'Brightline Counsel', li: 'saoirse-nolan', email: 'saoirse@brightlinecounsel.com', invited: 8, status: 'working', score: 66 },
  { first: 'Tomás', last: 'Ferreira', title: 'CTO', account: 'Caseflow', li: 'tomasferreira', email: 'tomas@caseflow.io', invited: 7, connected: 3, status: 'engaged', score: 79 },
  { first: 'Priya', last: 'Anand', title: 'Director of Court Reporting', account: 'Verity Depositions', li: 'priya-anand-legal', email: 'priya@veritydepo.com', invited: 6, status: 'working', score: 71 },
  { first: 'Callum', last: 'Reid', title: 'Practice Manager', account: 'Halden Chambers', li: 'callum-reid-chambers', email: 'callum@haldenchambers.co.uk', invited: 24, status: 'working', score: 58 },
  { first: 'Ingrid', last: 'Sandvik', title: 'Chief Operating Officer', account: 'Caseflow', li: 'ingrid-sandvik', email: 'ingrid@caseflow.io', status: 'new', score: 63 },
  { first: 'Marcus', last: 'Bell', title: 'Partner', account: 'Marlow & Finch LLP', li: 'marcus-bell-law', email: 'm.bell@marlowfinch.co.uk', status: 'new', score: 69 },
  { first: 'Yuki', last: 'Tanaka', title: 'Legal Counsel', account: 'Northgate Legal Ops', li: 'yuki-tanaka-counsel', email: 'yuki@northgatelegal.com', status: 'new', score: 55 },
  { first: 'Owen', last: 'Pritchard', title: 'Founder', account: 'Verity Depositions', li: 'owen-pritchard', email: 'owen@veritydepo.com', status: 'new', score: 72 },
]

const REPLIES = [
  { who: 'Andrew', subject: 'Re: court reporting turnaround', body: "This is timely — we're rebuilding exactly this bit and I'd genuinely like to compare notes. Are you free Thursday afternoon?", intent: 'interested' },
  { who: 'Dev', subject: 'Re: handoffs between systems', body: 'Interested but not this quarter. Send me something in September and I will pick it up then.', intent: 'not_now' },
  { who: 'Helena', subject: 'Automatic reply: Out of office', body: 'I am out of the office until 12 August with limited access to email.', intent: 'out_of_office' },
  { who: 'Callum', subject: 'Re: practice management', body: 'Please remove me from your list. Not interested.', intent: 'unsubscribe' },
]

async function main() {
  // By slug, not "the first one that is not a test tenant" — the test suites
  // create their own workspaces and an unpinned findFirst renames whichever one
  // the planner happens to return.
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  await db.tenant.update({ where: { id: tenant.id }, data: { name: 'Digip Technologies' } })
  const tenantId = tenant.id

  const owner = await db.user.findFirstOrThrow({ where: { tenantId, role: 'owner' } })
  await db.user.update({ where: { id: owner.id }, data: { name: 'Parthiv Prajapati' } })

  // --- wipe the parts this script owns, so re-running is idempotent ----------
  await db.task.deleteMany({ where: { tenantId } })
  await db.activity.deleteMany({ where: { tenantId } })
  await db.emailMessage.deleteMany({ where: { tenantId } })
  await db.sequenceEnrollment.deleteMany({ where: { tenantId } })
  await db.deal.deleteMany({ where: { tenantId } })
  await db.contact.deleteMany({ where: { tenantId } })
  await db.account.deleteMany({ where: { tenantId } })

  const accountIds = new Map<string, string>()
  for (const a of ACCOUNTS) {
    const created = await db.account.create({
      data: { tenantId, ownerId: owner.id, enrichedAt: ago(3), ...a },
    })
    accountIds.set(a.name, created.id)
  }

  const contactIds = new Map<string, string>()
  for (const p of PEOPLE) {
    const c = await db.contact.create({
      data: {
        tenantId,
        firstName: p.first,
        lastName: p.last,
        title: p.title,
        email: p.email,
        emailStatus: 'valid',
        linkedinUrl: p.li ? `https://www.linkedin.com/in/${p.li}` : null,
        accountId: accountIds.get(p.account)!,
        ownerId: owner.id,
        status: p.status ?? 'new',
        score: p.score ?? 50,
        source: 'csv',
        city: ACCOUNTS.find((a) => a.name === p.account)?.city,
        country: ACCOUNTS.find((a) => a.name === p.account)?.country,
        linkedinInvitedAt: p.invited ? ago(p.invited) : null,
        linkedinConnectedAt: p.connected ? ago(p.connected) : null,
        lastRepliedAt: p.replied ? ago(p.replied) : null,
        lastContactedAt: p.invited ? ago(p.invited) : null,
        enrichedAt: ago(3),
      },
    })
    contactIds.set(p.first, c.id)
  }

  // --- pipeline -------------------------------------------------------------
  const stages = await db.pipelineStage.findMany({ where: { tenantId }, orderBy: { order: 'asc' } })
  const DEALS: { contact: string; title: string; value: number; stage: number; close: number }[] = [
    { contact: 'Andrew', title: 'DepoStack — transcript pipeline', value: 24000, stage: 2, close: 21 },
    { contact: 'Dev', title: 'Northgate — legal ops tooling', value: 48000, stage: 1, close: 45 },
    { contact: 'Borong', title: 'Zhong Lun — matter intake', value: 65000, stage: 1, close: 60 },
    { contact: 'Tomás', title: 'Caseflow — integration build', value: 18000, stage: 0, close: 30 },
    { contact: 'Helena', title: 'Marlow & Finch — discovery', value: 12000, stage: 0, close: 40 },
  ]
  for (const d of DEALS) {
    const contactId = contactIds.get(d.contact)!
    const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } })
    await db.deal.create({
      data: {
        tenantId,
        name: d.title,
        value: d.value,
        currency: 'GBP',
        stageId: stages[Math.min(d.stage, stages.length - 1)].id,
        contactId,
        accountId: contact.accountId,
        ownerId: owner.id,
        expectedCloseDate: soon(d.close),
      },
    })
  }

  // --- sequences ------------------------------------------------------------
  await db.sequenceStep.deleteMany({ where: { sequence: { tenantId } } })
  await db.sequence.deleteMany({ where: { tenantId } })

  const campaign = await db.sequence.create({
    data: {
      tenantId, name: 'Legal tech — LinkedIn first', status: 'active', createdById: owner.id,
      stopOnReply: true, stopOnAccountReply: true,
    },
  })
  await db.sequenceStep.createMany({
    data: [
      { sequenceId: campaign.id, order: 0, type: 'linkedin_connect', bodyText: 'Hi {{first_name}} — most of my work is with legal teams on how matters get handed between people. Worth connecting.' },
      { sequenceId: campaign.id, order: 1, type: 'wait', delayMinutes: 4320 },
      { sequenceId: campaign.id, order: 2, type: 'linkedin_message', conditions: { type: 'if_connected' } as never, bodyText: 'Thanks for connecting, {{first_name}}. Curious what your intake process looks like today — no pitch.' },
      { sequenceId: campaign.id, order: 3, type: 'wait', delayMinutes: 5760 },
      { sequenceId: campaign.id, order: 4, type: 'email', conditions: { type: 'if_no_reply' } as never, subject: 'matter handoffs at {{company}}', bodyText: 'Hi {{first_name | there}},\n\nWe build software for legal teams, and the thing that comes up most is time lost handing a matter between people.\n\nWorth twenty minutes to compare notes?\n\n{{sender_first_name}}' },
    ],
  })

  const nurture = await db.sequence.create({
    data: { tenantId, name: 'Re-engage — went quiet', status: 'paused', createdById: owner.id },
  })
  await db.sequenceStep.createMany({
    data: [
      { sequenceId: nurture.id, order: 0, type: 'email', subject: 'still worth a look?', bodyText: 'Hi {{first_name | there}},\n\nPicking this back up — is intake still on your list for this year?\n\n{{sender_first_name}}' },
    ],
  })

  for (const p of PEOPLE.filter((x) => x.li).slice(0, 8)) {
    await db.sequenceEnrollment.create({
      data: {
        tenantId, sequenceId: campaign.id, contactId: contactIds.get(p.first)!,
        status: p.replied ? 'stopped_replied' : p.connected ? 'active' : 'waiting_on_human',
        startedAt: ago(p.invited ?? 5),
        waitingUntil: p.connected || p.replied ? null : soon(9),
        stoppedAt: p.replied ? ago(p.replied) : null,
        stopReason: p.replied ? 'Contact replied' : null,
      },
    })
  }

  // --- inbox ----------------------------------------------------------------
  for (const [i, r] of REPLIES.entries()) {
    const contactId = contactIds.get(r.who)!
    // messageId is unique across the whole table, not per tenant, so these carry
    // a run marker — otherwise a second run collides with its own first.
    const stamp = Math.floor(Date.now() / 1000)
    const sentId = `<out-${i}-${stamp}@digiptechnologies.com>`
    await db.emailMessage.create({
      data: {
        tenantId, direction: 'outbound', status: 'sent', contactId,
        fromEmail: 'parthiv.prajapati@digiptechnologies.com',
        toEmail: PEOPLE.find((p) => p.first === r.who)!.email!,
        subject: r.subject.replace(/^Re: /, ''), bodyText: 'Original outbound message.',
        messageId: sentId, threadKey: sentId, sentAt: ago(4 + i), opensCount: 2, clicksCount: i === 0 ? 1 : 0,
      },
    })
    await db.emailMessage.create({
      data: {
        tenantId, direction: 'inbound', status: 'replied', contactId,
        fromEmail: PEOPLE.find((p) => p.first === r.who)!.email!,
        toEmail: 'parthiv.prajapati@digiptechnologies.com',
        subject: r.subject, bodyText: r.body,
        messageId: `<in-${i}-${stamp}@example.test>`, inReplyTo: sentId, threadKey: sentId,
        repliedAt: ago(1 + i),
      },
    })
  }

  // --- today's LinkedIn queue ----------------------------------------------
  const queue: { who: string; title: string; due: number; priority: number }[] = [
    { who: 'Ingrid', title: 'Connect with Ingrid Sandvik', due: 0, priority: 1 },
    { who: 'Marcus', title: 'Connect with Marcus Bell', due: 0, priority: 1 },
    { who: 'Owen', title: 'Connect with Owen Pritchard', due: 0, priority: 1 },
    { who: 'Yuki', title: 'Connect with Yuki Tanaka', due: 0, priority: 0 },
  ]
  for (const q of queue) {
    const contactId = contactIds.get(q.who)!
    const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } })
    await db.task.create({
      data: {
        tenantId, type: 'linkedin', status: 'open', title: q.title,
        contactId, accountId: contact.accountId, assigneeId: owner.id,
        dueAt: ago(q.due), priority: q.priority,
        payload: { stepType: 'linkedin_connect', linkedinUrl: contact.linkedinUrl } as never,
      },
    })
  }
  await db.task.create({
    data: {
      tenantId, type: 'linkedin', status: 'open',
      title: 'Message Tomás — they accepted',
      contactId: contactIds.get('Tomás')!, assigneeId: owner.id,
      dueAt: ago(0), priority: 2,
      payload: { stepType: 'linkedin_message', linkedinUrl: 'https://www.linkedin.com/in/tomasferreira' } as never,
    },
  })
  await db.task.create({
    data: {
      tenantId, type: 'follow_up', status: 'open', title: 'Send Andrew the Thursday slot',
      contactId: contactIds.get('Andrew')!, assigneeId: owner.id, dueAt: ago(0), priority: 2,
    },
  })

  // --- history, so the timelines are not blank ------------------------------
  for (const p of PEOPLE.filter((x) => x.connected)) {
    await db.activity.create({
      data: {
        tenantId, type: 'linkedin', summary: 'Accepted the connection request',
        contactId: contactIds.get(p.first)!, occurredAt: ago(p.connected!),
        detail: { source: 'linkedin-notification-email' },
      },
    })
  }
  for (const p of PEOPLE.filter((x) => x.invited)) {
    await db.activity.create({
      data: {
        tenantId, type: 'linkedin', summary: 'Connection request sent',
        contactId: contactIds.get(p.first)!, occurredAt: ago(p.invited!),
        detail: { source: 'human-in-the-loop' },
      },
    })
  }

  // Mailbox, so the sending screens are populated rather than empty.
  await db.mailbox.deleteMany({ where: { tenantId } })
  await db.mailbox.create({
    data: {
      tenantId, email: 'parthiv.prajapati@digiptechnologies.com', fromName: 'Parthiv Prajapati',
      provider: 'outlook', userId: owner.id,
      spfOk: true, dkimOk: true, dmarcOk: true, lastCheckedAt: new Date(),
      health: 'warming', dailyCap: 20, warmupTarget: 200, sentToday: 4, sentTodayOn: new Date(),
      credentials: {} as never,
    },
  })

  console.log(`Seeded ${PEOPLE.length} contacts, ${ACCOUNTS.length} accounts, ${DEALS.length} deals`)
}

main().finally(() => db.$disconnect())
