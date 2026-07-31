'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { recordAction, enqueueContacts } from '@/lib/linkedin/queue'
import { importSalesNav, type SalesNavField, type SalesNavResult } from '@/lib/linkedin/import'
import { assessPacing, withinLimit, type LinkedInActionType } from '@/lib/linkedin/policy'
import { audit } from '@/lib/audit'
import { enqueue } from '@/lib/queue'
import { apolloEnabled, isStale } from '@/lib/apollo'
import { logger } from '@/lib/logger'

export type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const recordSchema = z.object({
  taskId: z.string().min(1),
  outcome: z.enum(['sent', 'skipped', 'already_connected', 'not_a_fit']),
  finalText: z.string().max(8000).optional(),
  note: z.string().max(2000).optional(),
})

export async function record(input: z.input<typeof recordSchema>): Promise<Result> {
  const auth = await requireAuth()
  const parsed = recordSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  const d = parsed.data

  try {
    await withTenant(auth.tenant.id, async () => {
      const task = await db().task.findUniqueOrThrow({ where: { id: d.taskId } })
      if (task.assigneeId && task.assigneeId !== auth.user.id && auth.user.role === 'rep') {
        throw new Error('That card belongs to someone else.')
      }

      const action = ((task.payload as { stepType?: string } | null)?.stepType ?? 'linkedin_connect')
        .replace('linkedin_', '') as LinkedInActionType

      // The ceiling is checked server-side too. A client-only cap is a suggestion.
      if (d.outcome === 'sent') {
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const doneToday = await db().task.count({
          where: {
            type: 'linkedin', assigneeId: auth.user.id, status: 'completed',
            outcome: 'sent', completedAt: { gte: startOfDay },
          },
        })
        const pacing = assessPacing(action, doneToday)
        if (!pacing.allowed) throw new Error(pacing.message ?? 'Daily ceiling reached.')

        if (d.finalText && !withinLimit(action, d.finalText)) {
          throw new Error('That message is over LinkedIn\'s length limit and would be truncated.')
        }
      }

      await recordAction({
        taskId: d.taskId,
        actorId: auth.user.id,
        outcome: d.outcome,
        note: d.note,
        finalText: d.finalText,
      })

      await audit({
        actorId: auth.user.id, action: 'update', entity: 'LinkedInCard',
        entityId: d.taskId, after: { outcome: d.outcome },
      })
    })

    revalidatePath('/linkedin')
    revalidatePath('/tasks')
    return { ok: true }
  } catch (err) {
    logger.error({ err }, 'record linkedin action failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not record that.' }
  }
}

/** Builds a queue from the highest-scoring contacts that have a profile URL. */
export async function buildTargetList(size: number): Promise<Result<{ queued: number; skipped: number }>> {
  const auth = await requireAuth()
  const n = Math.max(1, Math.min(50, Math.floor(size)))

  try {
    const r = await withTenant(auth.tenant.id, async () => {
      const contacts = await db().contact.findMany({
        where: {
          linkedinUrl: { not: null },
          status: { notIn: ['do_not_contact', 'unqualified', 'customer'] },
        },
        orderBy: { score: 'desc' },
        select: { id: true },
        take: n * 3, // over-fetch: enqueueContacts skips anyone already queued
      })
      return enqueueContacts({
        contactIds: contacts.slice(0, n * 3).map((c) => c.id),
        assigneeId: auth.user.id,
      })
    })
    revalidatePath('/linkedin')
    return { ok: true, data: r }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not build the list.' }
  }
}

const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).max(5000),
  mapping: z.record(z.string(), z.string()),
  dryRun: z.boolean(),
  listName: z.string().trim().max(120).optional(),
  assignToMe: z.boolean().default(true),
})

export async function runSalesNavImport(
  input: z.input<typeof importSchema>
): Promise<Result<SalesNavResult>> {
  const auth = await requireAuth()
  const parsed = importSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid import.' }
  }
  const d = parsed.data

  if (!d.mapping.linkedinUrl) {
    return { ok: false, error: 'Map a column to the LinkedIn profile URL — it is the dedupe key here.' }
  }

  try {
    const result = await withTenant(
      auth.tenant.id,
      () =>
        importSalesNav({
          rows: d.rows,
          mapping: d.mapping as Partial<Record<SalesNavField, string>>,
          ownerId: d.assignToMe ? auth.user.id : null,
          listName: d.listName ?? null,
          dryRun: d.dryRun,
        }),
      { timeout: 240_000 }
    )

    if (!d.dryRun) {
      revalidatePath('/contacts')
      revalidatePath('/linkedin')
    }
    return { ok: true, data: result }
  } catch (err) {
    logger.error({ err }, 'sales nav import failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Import failed.' }
  }
}

/**
 * Fills in the companies behind the queue, so the drafts have something to say.
 *
 * The enrichment jobs have existed since Phase 2 and were registered as handlers,
 * but nothing in the application ever enqueued one — the same shape of gap as
 * reply ingestion, where the machinery was built and tested and then never
 * called. The visible symptom was every card coming out `generic`: a contact
 * imported from a CSV has a name, a title and a city, and a city-only draft says
 * nothing about the person.
 *
 * Accounts rather than contacts on purpose. Industry and headcount are what the
 * draft hooks actually read, they live on the account, and they cost one credit
 * per company rather than one per person — three people at one firm is one call.
 */
export async function enrichQueueAccounts(): Promise<Result<{ queued: number; reason?: string }>> {
  const auth = await requireAuth()

  if (!apolloEnabled()) {
    return {
      ok: false,
      error:
        'Apollo is not configured. Add APOLLO_API_KEY to your .env and restart, then try again.',
    }
  }

  try {
    const accountIds = await withTenant(auth.tenant.id, async () => {
      // Only companies of people who could actually be worked — a profile URL is
      // what makes a contact queueable, so enriching anyone else spends credits
      // on records the queue will never show.
      const contacts = await db().contact.findMany({
        where: {
          linkedinUrl: { not: null },
          accountId: { not: null },
          status: { notIn: ['do_not_contact', 'unqualified'] },
        },
        select: { accountId: true },
        take: 2000,
      })
      const ids = [...new Set(contacts.map((c) => c.accountId!))]

      // isStale is re-checked inside the job, but filtering here keeps the job
      // payload honest so "queued 0" means "nothing needed doing" rather than
      // "queued 40 no-ops".
      const stale = await db().account.findMany({
        where: { id: { in: ids }, domain: { not: null } },
        select: { id: true, enrichedAt: true },
      })
      return stale.filter((a) => isStale(a.enrichedAt)).map((a) => a.id)
    })

    if (accountIds.length === 0) {
      return { ok: true, data: { queued: 0, reason: 'Every company already has recent data.' } }
    }

    await enqueue('enrichment:account', { tenantId: auth.tenant.id, accountIds })

    await audit({
      actorId: auth.user.id,
      action: 'update',
      entity: 'Account',
      entityId: accountIds[0],
      after: { enrichmentQueued: accountIds.length },
    })

    revalidatePath('/linkedin')
    revalidatePath('/accounts')
    return { ok: true, data: { queued: accountIds.length } }
  } catch (err) {
    logger.error({ err }, 'queueing account enrichment failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not queue enrichment.' }
  }
}
