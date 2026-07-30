import { withTenant, db, tid } from '../../lib/db'
import { logger } from '../../lib/logger'
import {
  apolloEnabled, bulkEnrichPeople, enrichOrganization,
  personToContactFields, organizationToAccountFields, isStale,
} from '../../lib/apollo'
import { rescoreContact } from '../../lib/leads/scoring'
import { domainFromEmail } from '../../lib/utils'

/**
 * Enrichment. Every Apollo call costs credits, so this is the only place that
 * calls them, and it enforces three economies:
 *   - skip records enriched recently (isStale)
 *   - use the bulk endpoint (10 per call)
 *   - stop when the tenant's monthly credit allowance is spent
 */

async function creditsRemaining(tenantId: string): Promise<number> {
  const tenant = await db().tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { enrichCreditLimit: true },
  })
  const period = new Date().toISOString().slice(0, 7)
  const counter = await db().usageCounter.findFirst({
    where: { period, metric: 'enrich_credits' },
    select: { value: true },
  })
  return Math.max(0, tenant.enrichCreditLimit - (counter?.value ?? 0))
}

async function spendCredits(tenantId: string, n: number) {
  const period = new Date().toISOString().slice(0, 7)
  const existing = await db().usageCounter.findFirst({
    where: { period, metric: 'enrich_credits' },
    select: { id: true },
  })
  if (existing) {
    await db().usageCounter.update({
      where: { id: existing.id },
      data: { value: { increment: n } },
    })
  } else {
    await db().usageCounter.create({
      data: { tenantId, period, metric: 'enrich_credits', value: n },
    })
  }
}

export async function enrichContacts({
  tenantId,
  contactIds,
}: {
  tenantId: string
  contactIds: string[]
}) {
  if (!apolloEnabled()) {
    logger.info('Apollo not configured; enrichment skipped')
    return { skipped: contactIds.length, reason: 'apollo_not_configured' }
  }

  return withTenant(
    tenantId,
    async () => {
      const budget = await creditsRemaining(tenantId)
      if (budget <= 0) {
        logger.warn({ tenantId }, 'enrichment credit allowance exhausted for this period')
        return { skipped: contactIds.length, reason: 'credit_limit' }
      }

      const contacts = await db().contact.findMany({
        where: { id: { in: contactIds } },
        include: { account: { select: { domain: true } } },
      })

      const targets = contacts.filter((c) => isStale(c.enrichedAt)).slice(0, budget)
      if (!targets.length) return { enriched: 0, skipped: contacts.length, reason: 'all_fresh' }

      const matches = await bulkEnrichPeople(
        targets.map((c) => ({
          email: c.email ?? undefined,
          firstName: c.firstName ?? undefined,
          lastName: c.lastName ?? undefined,
          domain: c.account?.domain ?? (c.email ? domainFromEmail(c.email) ?? undefined : undefined),
          linkedinUrl: c.linkedinUrl ?? undefined,
        }))
      )

      let enriched = 0
      for (let i = 0; i < targets.length; i++) {
        const contact = targets[i]
        const person = matches[i]
        if (!person) continue

        const fields = personToContactFields(person)

        // Never overwrite a value a human curated; fill gaps and refresh
        // provider-owned fields only.
        const patch: Record<string, unknown> = {
          apolloId: fields.apolloId,
          enrichedAt: fields.enrichedAt,
        }
        for (const k of ['firstName', 'lastName', 'title', 'linkedinUrl', 'city', 'country'] as const) {
          if (contact[k] == null && fields[k] != null) patch[k] = fields[k]
        }
        if (contact.emailStatus === 'unverified' && fields.emailStatus) {
          patch.emailStatus = fields.emailStatus
        }

        await db().contact.update({ where: { id: contact.id }, data: patch })

        // Attach or enrich the company while we have the payload.
        const orgDomain = person.organization?.primary_domain?.toLowerCase()
        if (orgDomain) {
          const account = await db().account.findFirst({ where: { domain: orgDomain } })
          if (!account) {
            const created = await db().account.create({
              data: {
                tenantId: tid(),
                name: person.organization?.name ?? orgDomain,
                domain: orgDomain,
                industry: person.organization?.industry,
                employeeCount: person.organization?.estimated_num_employees,
                linkedinUrl: person.organization?.linkedin_url,
                websiteUrl: person.organization?.website_url,
                city: person.organization?.city,
                country: person.organization?.country,
                enrichedAt: new Date(),
              },
            })
            await db().contact.update({
              where: { id: contact.id },
              data: { accountId: created.id },
            })
          } else if (!contact.accountId) {
            await db().contact.update({
              where: { id: contact.id },
              data: { accountId: account.id },
            })
          }
        }

        await db().activity.create({
          data: {
            tenantId,
            type: 'sync',
            summary: 'Enriched from Apollo',
            contactId: contact.id,
            detail: { apolloId: fields.apolloId },
          },
        })

        await rescoreContact(contact.id)
        enriched++
      }

      await spendCredits(tenantId, targets.length)
      logger.info({ tenantId, enriched, attempted: targets.length }, 'contact enrichment complete')
      return { enriched, attempted: targets.length }
    },
    { timeout: 120_000 }
  )
}

export async function enrichAccounts({
  tenantId,
  accountIds,
}: {
  tenantId: string
  accountIds: string[]
}) {
  if (!apolloEnabled()) return { skipped: accountIds.length, reason: 'apollo_not_configured' }

  return withTenant(
    tenantId,
    async () => {
      const budget = await creditsRemaining(tenantId)
      if (budget <= 0) return { skipped: accountIds.length, reason: 'credit_limit' }

      const accounts = await db().account.findMany({
        where: { id: { in: accountIds }, domain: { not: null } },
      })
      const targets = accounts.filter((a) => isStale(a.enrichedAt)).slice(0, budget)

      let enriched = 0
      for (const account of targets) {
        try {
          const org = await enrichOrganization(account.domain!)
          if (!org) continue
          const fields = organizationToAccountFields(org)
          const patch: Record<string, unknown> = {
            apolloId: fields.apolloId,
            enrichedAt: fields.enrichedAt,
          }
          for (const k of [
            'industry', 'employeeCount', 'annualRevenue', 'linkedinUrl',
            'websiteUrl', 'city', 'country', 'description',
          ] as const) {
            if (account[k] == null && fields[k] != null) patch[k] = fields[k]
          }
          await db().account.update({ where: { id: account.id }, data: patch })
          enriched++
        } catch (err) {
          logger.warn({ err, accountId: account.id }, 'account enrichment failed')
        }
      }

      await spendCredits(tenantId, targets.length)
      return { enriched, attempted: targets.length }
    },
    { timeout: 120_000 }
  )
}

export async function recomputeScores({
  tenantId,
  contactIds,
}: {
  tenantId: string
  contactIds?: string[]
}) {
  return withTenant(
    tenantId,
    async () => {
      const ids =
        contactIds ??
        (await db().contact.findMany({ select: { id: true }, take: 5000 })).map((c) => c.id)

      let changed = 0
      for (const id of ids) {
        try {
          await rescoreContact(id)
          changed++
        } catch (err) {
          logger.warn({ err, contactId: id }, 'rescore failed')
        }
      }
      return { rescored: changed }
    },
    { timeout: 300_000 }
  )
}
