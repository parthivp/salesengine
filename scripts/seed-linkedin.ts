import 'dotenv/config'
import { prismaAdmin, withTenant, db, disconnect } from '../src/lib/db'
import { parseSalesNav, importSalesNav } from '../src/lib/linkedin/import'
import { enqueueContacts } from '../src/lib/linkedin/queue'
import { rescoreContact } from '../src/lib/leads/scoring'

/**
 * Seeds the LinkedIn queue: a Sales Navigator style export (no email column,
 * which is the whole reason that importer exists) plus queue cards for the owner.
 */

const CSV = `Profile URL,First Name,Last Name,Title,Company,Company Website,Location,Country
https://www.linkedin.com/in/rhea-venkataraman/,Rhea,Venkataraman,VP Revenue Operations,Northwind Logistics,northwind-logistics.test,Pune,India
https://linkedin.com/in/tomas-eriksson-ops?trk=nav,Tomas,Eriksson,Head of Sales,Kilnwater Systems,kilnwater.test,Stockholm,Sweden
https://www.linkedin.com/in/priya-balachandran/,Priya,Balachandran,Chief Operating Officer,Meridian Freight,meridianfreight.test,Chennai,India
https://www.linkedin.com/in/dele-adewale-cx/,Dele,Adewale,Director of Customer Success,Northwind Logistics,northwind-logistics.test,Lagos,Nigeria
https://www.linkedin.com/in/hannah-osei/,Hannah,Osei,Sales Operations Manager,Brightloom Retail,brightloom.test,Accra,Ghana
https://www.linkedin.com/in/yuki-tanabe-founder/,Yuki,Tanabe,Founder,Tanabe Analytics,tanabeanalytics.test,Osaka,Japan
https://www.linkedin.com/in/marco-silveira/,Marco,Silveira,Enterprise Account Executive,Kilnwater Systems,kilnwater.test,Lisbon,Portugal
https://www.linkedin.com/in/aisha-rahman-rev/,Aisha,Rahman,Revenue Operations Lead,Cadence Health,cadencehealth.test,Dubai,United Arab Emirates
not-a-linkedin-url,Broken,Row,,,,,
https://www.linkedin.com/in/rhea-venkataraman/,Rhea,Venkataraman,VP Revenue Operations,Northwind Logistics,northwind-logistics.test,Pune,India
`

async function main() {
  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })
  const owner = await prismaAdmin.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: 'parthiv@acme.test' },
  })

  await withTenant(
    tenant.id,
    async () => {
      const parsed = parseSalesNav(CSV)
      const result = await importSalesNav({
        rows: parsed.rows,
        mapping: parsed.suggested,
        ownerId: owner.id,
        listName: 'Sales Nav — RevOps Q3',
      })
      console.log(
        `Imported: ${result.created} created, ${result.updated} matched, ` +
          `${result.duplicates} duplicate, ${result.skipped} skipped, ` +
          `${result.withoutEmail} without email, ${result.accountsCreated} accounts`
      )
      for (const e of result.errors) console.log(`  row ${e.row}: ${e.reason}`)

      const imported = await db().contact.findMany({
        where: { source: 'linkedin_csv' },
        select: { id: true },
      })
      // Sales Nav rows carry a title and a company but no email, so the score
      // they get on import is the fit half only. Rescore so the queue ordering
      // reflects the account rows the importer just created.
      for (const c of imported) await rescoreContact(c.id)

      const connect = await enqueueContacts({
        contactIds: imported.map((c) => c.id),
        assigneeId: owner.id,
        action: 'connect',
      })
      console.log(`Queued ${connect.queued} connect cards (${connect.skipped} skipped)`)

      // A couple of message cards too, for people already emailed — that is the
      // realistic mix a rep opens the queue to.
      const emailed = await db().contact.findMany({
        where: { lastContactedAt: { not: null }, linkedinUrl: { not: null } },
        select: { id: true },
        take: 3,
      })
      const message = await enqueueContacts({
        contactIds: emailed.map((c) => c.id),
        assigneeId: owner.id,
        action: 'message',
      })
      console.log(`Queued ${message.queued} message cards (${message.skipped} skipped)`)
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
