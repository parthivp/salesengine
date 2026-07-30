import 'dotenv/config'
import { prismaAdmin, withTenant, db, tid, disconnect } from '../src/lib/db'
import { SALESFORCE_DEFAULTS } from '../src/lib/crm/mapping'

/**
 * Creates a Salesforce connection row with the default field mappings for the
 * `acme` tenant, so the integrations UI can be reviewed without a real org.
 *
 * Deliberately has no tokens: status stays 'disconnected' and the sync engine
 * will refuse to run, which is the honest representation of "not connected yet".
 */
async function main() {
  const tenant = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })

  await withTenant(tenant.id, async () => {
    let conn = await db().crmConnection.findFirst({ where: { provider: 'salesforce' } })
    if (!conn) {
      conn = await db().crmConnection.create({
        data: {
          tenantId: tid(),
          provider: 'salesforce',
          status: 'disconnected',
          syncEnabled: false,
          credentials: { conflictPolicy: 'last_write_wins' } as never,
        },
      })
    }

    let created = 0
    for (const m of SALESFORCE_DEFAULTS) {
      const existing = await db().crmFieldMapping.findFirst({
        where: {
          connectionId: conn.id, object: m.object,
          localField: m.localField, remoteField: m.remoteField,
        },
      })
      if (existing) continue
      await db().crmFieldMapping.create({
        data: {
          connectionId: conn.id,
          object: m.object,
          localField: m.localField,
          remoteField: m.remoteField,
          direction: m.direction,
          transform: m.transform ?? null,
          transformConfig: (m.transformConfig ?? {}) as never,
        },
      })
      created++
    }

    console.log(`Salesforce connection ready with ${created} new mappings (status: ${conn.status})`)
  }, { timeout: 60_000 })
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => disconnect())
