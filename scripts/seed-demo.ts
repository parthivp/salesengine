import 'dotenv/config'
import { prismaAdmin, withTenant, db, tid } from '../src/lib/db'
import { importContacts, parseCsv } from '../src/lib/leads/import'
import { rescoreContact } from '../src/lib/leads/scoring'

/**
 * Demo data for the `acme` tenant. Runs through the real import path rather
 * than inserting rows directly, so what you see on screen is what the product
 * actually produces.
 *
 *   npx tsx scripts/seed-demo.ts
 */

const CSV = `First Name,Last Name,Email,Title,Company,Company Domain,Person Linkedin Url,Company City,Company Country
Priya,Raman,priya.raman@northwind.io,VP of Sales,Northwind Logistics,northwind.io,https://linkedin.com/in/priyaraman,Bengaluru,India
Daniel,Okafor,daniel.okafor@northwind.io,Head of Revenue Operations,Northwind Logistics,northwind.io,,Bengaluru,India
Sofia,Marchetti,sofia@lumenpay.com,Chief Revenue Officer,LumenPay,lumenpay.com,https://linkedin.com/in/sofiamarchetti,Milan,Italy
Tomas,Hale,tomas.hale@lumenpay.com,Sales Manager,LumenPay,lumenpay.com,,Milan,Italy
Aisha,Bello,aisha.bello@vertexhealth.co,Director of Business Development,Vertex Health,vertexhealth.co,,Lagos,Nigeria
Ben,Whitfield,ben@quaystone.com,Founder,Quaystone Advisory,quaystone.com,https://linkedin.com/in/benwhitfield,London,United Kingdom
Marcus,Lund,marcus.lund@arborgrid.se,Head of Growth,ArborGrid,arborgrid.se,,Stockholm,Sweden
Yuki,Tanaka,yuki.tanaka@meridianworks.jp,Senior Account Executive,Meridian Works,meridianworks.jp,,Tokyo,Japan
Elena,Duarte,elena@casadeltech.es,Marketing Director,Casa del Tech,casadeltech.es,,Madrid,Spain
Raj,Malhotra,raj.malhotra@stellarfin.in,Chief Operating Officer,StellarFin,stellarfin.in,https://linkedin.com/in/rajmalhotra,Mumbai,India
Nadia,Kovacs,nadia@brightloop.dev,Engineering Manager,BrightLoop,brightloop.dev,,Budapest,Hungary
Omar,Haddad,omar.haddad@dunespark.ae,VP Partnerships,DuneSpark,dunespark.ae,,Dubai,United Arab Emirates
Clara,Nkemdirim,clara@zenithretail.com,Head of Sales,Zenith Retail,zenithretail.com,,Accra,Ghana
Felix,Braun,felix.braun@orbitalcast.de,Business Development Manager,OrbitalCast,orbitalcast.de,,Berlin,Germany
Ana,Ferreira,ana.ferreira@tidalworks.pt,Intern,TidalWorks,tidalworks.pt,,Lisbon,Portugal
,,bad-email-row,Analyst,Broken Co,broken.test,,,
Priya,Raman,priya.raman@northwind.io,VP of Sales,Northwind Logistics,northwind.io,,Bengaluru,India
`

const EMPLOYEE_COUNTS: Record<string, number> = {
  'northwind.io': 420,
  'lumenpay.com': 180,
  'vertexhealth.co': 1200,
  'quaystone.com': 12,
  'arborgrid.se': 95,
  'meridianworks.jp': 3400,
  'casadeltech.es': 260,
  'stellarfin.in': 780,
  'brightloop.dev': 40,
  'dunespark.ae': 150,
  'zenithretail.com': 2100,
  'orbitalcast.de': 310,
  'tidalworks.pt': 65,
}

const INDUSTRIES: Record<string, string> = {
  'northwind.io': 'Logistics & Supply Chain',
  'lumenpay.com': 'Financial Services',
  'vertexhealth.co': 'Healthcare',
  'quaystone.com': 'Management Consulting',
  'arborgrid.se': 'Renewable Energy',
  'meridianworks.jp': 'Manufacturing',
  'casadeltech.es': 'Consumer Electronics',
  'stellarfin.in': 'Financial Services',
  'brightloop.dev': 'Software',
  'dunespark.ae': 'Real Estate',
  'zenithretail.com': 'Retail',
  'orbitalcast.de': 'Media & Broadcasting',
  'tidalworks.pt': 'Marine Engineering',
}

async function main() {
  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  const rep = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'rohan@acme.test' },
  })
  const manager = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'maya@acme.test' },
  })

  const parsed = parseCsv(CSV)

  const result = await withTenant(
    tenant.id,
    async () => {
      const list = await db().contactList.findFirst({ where: { name: 'Q3 outbound' } })
      const listId = list?.id ?? (await db().contactList.create({
        data: { tenantId: tid(), name: 'Q3 outbound', description: 'Seeded demo segment' },
      })).id

      return importContacts({
        rows: parsed.rows,
        mapping: parsed.suggested,
        ownerId: rep.id,
        listId,
        source: 'csv',
      })
    },
    { timeout: 120_000 }
  )

  console.log(
    `Imported: ${result.created} created, ${result.updated} updated, ` +
      `${result.accountsCreated} accounts, ${result.skipped} skipped`
  )

  // Fill in the firmographics Apollo would normally supply, so scoring has
  // something to work with without spending credits.
  await withTenant(tenant.id, async () => {
    for (const [domain, employeeCount] of Object.entries(EMPLOYEE_COUNTS)) {
      const account = await db().account.findFirst({ where: { domain } })
      if (!account) continue
      await db().account.update({
        where: { id: account.id },
        data: {
          employeeCount,
          industry: INDUSTRIES[domain],
          enrichedAt: new Date(),
          ownerId: manager.id,
        },
      })
    }

    // A plausible spread of engagement so the score bands are visible.
    const contacts = await db().contact.findMany({ orderBy: { email: 'asc' } })

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      const patch: Record<string, unknown> = {}

      if (i % 3 === 0) patch.emailStatus = 'valid'
      if (i % 5 === 0) patch.status = 'engaged'
      if (i % 7 === 0) patch.status = 'qualified'
      if (i % 11 === 0) patch.unsubscribedAt = new Date()
      if (i % 4 === 0) patch.ownerId = manager.id

      if (Object.keys(patch).length) {
        await db().contact.update({ where: { id: c.id }, data: patch })
      }

      // A few replies, so 'Hot' is earned rather than asserted.
      if (i % 6 === 0) {
        await db().emailMessage.create({
          data: {
            tenantId: tid(),
            direction: 'inbound',
            status: 'replied',
            contactId: c.id,
            fromEmail: c.email ?? 'unknown@example.test',
            toEmail: 'rohan@acme.test',
            subject: 'Re: quick question',
            bodyText: 'Happy to take a look — can you send over pricing?',
            repliedAt: new Date(),
          },
        })
        await db().activity.create({
          data: {
            tenantId: tid(),
            type: 'reply',
            summary: 'Replied to outreach',
            contactId: c.id,
            accountId: c.accountId,
          },
        })
      } else if (i % 3 === 1) {
        await db().emailMessage.create({
          data: {
            tenantId: tid(),
            direction: 'outbound',
            status: 'opened',
            contactId: c.id,
            fromEmail: 'rohan@acme.test',
            toEmail: c.email ?? 'unknown@example.test',
            subject: 'Cutting your fulfilment lead time',
            bodyText: 'Noticed you are scaling the ops team…',
            opensCount: 2,
            clicksCount: i % 2,
            sentAt: new Date(),
            openedAt: new Date(),
          },
        })
      }

      await rescoreContact(c.id)
    }

    // An inbound lead awaiting triage, plus the capture form that produced it.
    const form = await db().captureForm.findFirst({ where: { name: 'Website demo request' } })
    const formId = form?.id ?? (await db().captureForm.create({
      data: {
        tenantId: tid(),
        name: 'Website demo request',
        publicKey: 'demo_pk_acme_website',
        assignRule: { kind: 'round_robin' },
        fieldMap: {},
      },
    })).id

    const existingLead = await db().lead.findFirst({ where: { email: 'harpreet@finlynx.io' } })
    if (!existingLead) {
      await db().lead.create({
        data: {
          tenantId: tid(),
          email: 'harpreet@finlynx.io',
          firstName: 'Harpreet',
          lastName: 'Sandhu',
          company: 'Finlynx',
          title: 'Head of Sales',
          message: 'Interested in a demo for a 30-person team.',
          source: 'form',
          sourceMeta: { formId, utm: { source: 'linkedin', campaign: 'q3-brand' } },
          ownerId: rep.id,
        },
      })
    }

    await db().task.createMany({
      data: [
        {
          tenantId: tid(), type: 'follow_up', title: 'Follow up with Priya on pricing',
          assigneeId: rep.id, dueAt: new Date(Date.now() + 86_400_000), priority: 2,
        },
        {
          tenantId: tid(), type: 'call', title: 'Discovery call — Sofia Marchetti',
          assigneeId: rep.id, dueAt: new Date(Date.now() + 2 * 86_400_000), priority: 1,
        },
        {
          tenantId: tid(), type: 'follow_up', title: 'Triage inbound lead: Harpreet Sandhu',
          assigneeId: manager.id, dueAt: new Date(), priority: 3,
        },
      ],
      skipDuplicates: true,
    })
  }, { timeout: 180_000 })

  const [contacts, accounts, leads, tasks] = await Promise.all([
    prismaAdmin.contact.count({ where: { tenantId: tenant.id } }),
    prismaAdmin.account.count({ where: { tenantId: tenant.id } }),
    prismaAdmin.lead.count({ where: { tenantId: tenant.id } }),
    prismaAdmin.task.count({ where: { tenantId: tenant.id } }),
  ])

  console.log(`Demo data ready: ${contacts} contacts, ${accounts} accounts, ${leads} leads, ${tasks} tasks`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prismaAdmin.$disconnect())
