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
import { rewriteDraft, rewriteEnabled, unsupportedClaims } from '@/lib/ai/rewrite'
import { importConnections, type ConnectionsResult } from '@/lib/linkedin/connections'
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

/**
 * Imports LinkedIn's own Connections export.
 *
 * The backstop to notification-email detection, which only sees mail arriving
 * after the mailbox was connected. This file is the complete list with dates, so
 * one upload backfills every connection made before that — including every
 * invitation sent before any of this existed.
 */
export async function runConnectionsImport(input: {
  text: string
  dryRun: boolean
}): Promise<Result<ConnectionsResult>> {
  const auth = await requireAuth()
  const parsed = z
    .object({ text: z.string().min(1).max(20_000_000), dryRun: z.boolean() })
    .safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Could not read that file.' }

  try {
    const result = await withTenant(
      auth.tenant.id,
      () => importConnections(parsed.data.text, { dryRun: parsed.data.dryRun }),
      { timeout: 240_000 }
    )
    if (!parsed.data.dryRun) {
      revalidatePath('/linkedin')
      revalidatePath('/contacts')
    }
    return { ok: true, data: result }
  } catch (err) {
    logger.error({ err }, 'connections import failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Import failed.' }
  }
}

const improveSchema = z.object({
  contactId: z.string().min(1),
  rough: z.string().trim().min(1).max(4000),
  kind: z.enum(['connect', 'message']),
  limit: z.number().int().min(50).max(8000),
})

/**
 * Rewrites the rep's rough words into something sendable.
 *
 * The history is gathered here rather than asked of the rep, because the point of
 * doing it in the app instead of in a chat window is that the app already knows
 * what was sent, to whom, and when. Pasting that into ChatGPT by hand is the work
 * this removes.
 */
export async function improveDraft(
  input: z.input<typeof improveSchema>
): Promise<Result<{ text: string; unsupported: string[] }>> {
  const auth = await requireAuth()
  const parsed = improveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }
  if (!rewriteEnabled()) {
    return { ok: false, error: 'No OpenAI key configured. Add OPENAI_API_KEY to .env and restart.' }
  }
  const d = parsed.data

  try {
    const context = await withTenant(auth.tenant.id, async () => {
      const contact = await db().contact.findUniqueOrThrow({
        where: { id: d.contactId },
        include: { account: { select: { name: true, industry: true, employeeCount: true } } },
      })

      // What this person has already been sent. Anything else is a repeat.
      const priorTasks = await db().task.findMany({
        where: { contactId: d.contactId, type: 'linkedin', outcome: 'sent' },
        orderBy: { completedAt: 'asc' },
        select: { payload: true },
        take: 10,
      })
      const priorToContact = priorTasks
        .map((t) => (t.payload as { sentText?: string } | null)?.sentText)
        .filter((x): x is string => Boolean(x))

      // And what other people were sent recently, so this one does not echo them.
      const others = await db().task.findMany({
        where: { type: 'linkedin', outcome: 'sent', contactId: { not: d.contactId } },
        orderBy: { completedAt: 'desc' },
        select: { payload: true },
        take: 10,
      })
      const recentToOthers = others
        .map((t) => (t.payload as { sentText?: string } | null)?.sentText)
        .filter((x): x is string => Boolean(x))

      return { contact, priorToContact, recentToOthers }
    })

    const { contact } = context
    const req = {
      rough: d.rough,
      kind: d.kind,
      limit: d.limit,
      facts: {
        firstName: contact.firstName,
        title: contact.title,
        company: contact.account?.name ?? null,
        industry: contact.account?.industry ?? null,
        employeeCount: contact.account?.employeeCount ?? null,
        city: contact.city,
        emailedAlready: Boolean(contact.lastContactedAt),
        repliedAlready: Boolean(contact.lastRepliedAt),
        connectedOnLinkedIn: Boolean(contact.linkedinConnectedAt),
      },
      priorToContact: context.priorToContact,
      recentToOthers: context.recentToOthers,
      senderName: auth.user.name.split(' ')[0],
    }

    const r = await rewriteDraft(req)
    if (!r.ok) return { ok: false, error: r.error }

    // Surfaced, not silently stripped. The rep is the one who knows whether a
    // number is real, and a rewrite that quietly drops a true detail is its own
    // kind of wrong.
    return { ok: true, data: { text: r.text, unsupported: unsupportedClaims(r.text, req) } }
  } catch (err) {
    logger.error({ err }, 'improve draft failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not rewrite that.' }
  }
}
