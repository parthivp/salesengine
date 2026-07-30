'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { audit } from '@/lib/audit'
import { logger } from '@/lib/logger'

export type SettingsResult = { ok: true; message: string } | { ok: false; error: string }

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64),
  defaultSendWindowStart: z.coerce.number().int().min(0).max(23),
  defaultSendWindowEnd: z.coerce.number().int().min(1).max(24),
})

/**
 * Workspace settings.
 *
 * The send-window defaults live in `tenant.settings` and are applied to *new*
 * sequences only. Changing a default must not silently retime sequences that are
 * already running — someone who set an evening window for one campaign should not
 * find it moved because a default changed months later.
 */
export async function saveSettings(input: z.input<typeof schema>): Promise<SettingsResult> {
  const auth = await requirePermission('tenant:update')
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  const d = parsed.data

  if (d.defaultSendWindowEnd <= d.defaultSendWindowStart) {
    return { ok: false, error: 'The window has to end after it starts.' }
  }

  try {
    await withTenant(auth.tenant.id, async () => {
      const before = await db().tenant.findUniqueOrThrow({
        where: { id: tid() },
        select: { name: true, settings: true },
      })

      const settings = {
        ...((before.settings ?? {}) as Record<string, unknown>),
        timezone: d.timezone,
        defaultSendWindowStart: d.defaultSendWindowStart,
        defaultSendWindowEnd: d.defaultSendWindowEnd,
      }

      await db().tenant.update({
        where: { id: tid() },
        data: { name: d.name, settings: settings as never },
      })

      await audit({
        actorId: auth.user.id,
        action: 'update',
        entity: 'Tenant',
        entityId: tid(),
        before: { name: before.name, ...((before.settings ?? {}) as Record<string, unknown>) },
        after: { name: d.name, ...settings },
      })
    })

    revalidatePath('/admin/settings')
    return { ok: true, message: 'Saved. New sequences will use these defaults.' }
  } catch (err) {
    logger.error({ err }, 'settings save failed')
    return { ok: false, error: 'Could not save those settings.' }
  }
}
