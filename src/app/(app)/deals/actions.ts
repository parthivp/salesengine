'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { moveDeal } from '@/lib/workflow/pipeline'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'

export type Result = { ok: true } | { ok: false; error: string }

export async function move(dealId: string, toStageId: string): Promise<Result> {
  const auth = await requirePermission('deal:update')
  try {
    await withTenant(auth.tenant.id, async () => {
      const deal = await db().deal.findUniqueOrThrow({ where: { id: dealId } })
      if (auth.user.role === 'rep' && deal.ownerId && deal.ownerId !== auth.user.id) {
        throw new Error('That deal belongs to someone else.')
      }
      await moveDeal({ dealId, toStageId, actorId: auth.user.id })
      await audit({
        actorId: auth.user.id, action: 'update', entity: 'Deal',
        entityId: dealId, after: { stageId: toStageId },
      })
    })
    revalidatePath('/deals')
    return { ok: true }
  } catch (err) {
    logger.error({ err }, 'move deal failed')
    return { ok: false, error: err instanceof Error ? err.message : 'Could not move the deal.' }
  }
}

const createSchema = z.object({
  name: z.string().trim().min(2).max(200),
  value: z.number().min(0).max(1_000_000_000),
  contactId: z.string().optional(),
  closeInDays: z.number().int().min(1).max(730).default(30),
})

export async function createDeal(input: z.input<typeof createSchema>): Promise<Result> {
  const auth = await requirePermission('deal:create')
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid deal.' }
  const d = parsed.data

  try {
    await withTenant(auth.tenant.id, async () => {
      const first = await db().pipelineStage.findFirstOrThrow({ orderBy: { order: 'asc' } })
      const contact = d.contactId
        ? await db().contact.findUnique({
            where: { id: d.contactId },
            select: { id: true, accountId: true },
          })
        : null

      await db().deal.create({
        data: {
          tenantId: auth.tenant.id,
          name: d.name,
          value: d.value,
          stageId: first.id,
          contactId: contact?.id,
          accountId: contact?.accountId,
          ownerId: auth.user.id,
          expectedCloseDate: new Date(Date.now() + d.closeInDays * 86_400_000),
          lastActivityAt: new Date(),
        },
      })
    })
    revalidatePath('/deals')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create the deal.' }
  }
}
