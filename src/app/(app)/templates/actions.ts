'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { lintContent, type LintResult } from '@/lib/email/deliverability'
import { render, valuesFor, unknownTags } from '@/lib/email/merge'
import { audit } from '@/lib/audit'

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  subject: z.string().trim().min(1).max(300),
  bodyText: z.string().trim().min(1).max(20000),
})

export type SaveResult =
  | { ok: true; lint: LintResult }
  | { ok: false; error: string; lint?: LintResult }

export async function saveTemplate(input: z.input<typeof schema>): Promise<SaveResult> {
  const auth = await requirePermission('template:create')

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid template.' }
  }
  const d = parsed.data

  const bad = unknownTags(`${d.subject} ${d.bodyText}`)
  if (bad.length) {
    return {
      ok: false,
      error: `Unknown merge ${bad.length === 1 ? 'tag' : 'tags'}: ${bad
        .map((t) => `{{${t}}}`)
        .join(', ')}. These would never resolve.`,
    }
  }

  const lint = lintContent({ subject: d.subject, bodyText: d.bodyText, hasUnsubscribe: true })
  if (lint.blocking) {
    const first = lint.findings.find((f) => f.severity === 'error')
    return { ok: false, error: first?.message ?? 'Content check failed.', lint }
  }

  try {
    await withTenant(auth.tenant.id, async () => {
      const existing = await db().emailTemplate.findFirst({ where: { name: d.name } })
      const payload = {
        subject: d.subject,
        bodyText: d.bodyText,
        // Stored as text; the engine renders plain-text-first HTML at send time so
        // tracking and unsubscribe links are per-message rather than baked in.
        bodyHtml: '',
        spamScore: lint.score,
      }

      if (existing) {
        await db().emailTemplate.update({ where: { id: existing.id }, data: payload })
        await audit({ actorId: auth.user.id, action: 'update', entity: 'EmailTemplate', entityId: existing.id })
      } else {
        const created = await db().emailTemplate.create({
          data: { tenantId: tid(), name: d.name, createdById: auth.user.id, ...payload },
        })
        await audit({ actorId: auth.user.id, action: 'create', entity: 'EmailTemplate', entityId: created.id })
      }
    })

    revalidatePath('/templates')
    return { ok: true, lint }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the template.' }
  }
}

export type PreviewResult = {
  lint: LintResult
  subject: string
  body: string
  unresolved: string[]
  unknown: string[]
}

/**
 * Renders against a real contact so the preview shows what a prospect would
 * actually receive — a preview against dummy data hides exactly the gaps that
 * matter (a contact with no company, no first name).
 */
export async function previewTemplate(input: {
  subject: string
  bodyText: string
}): Promise<PreviewResult> {
  const auth = await requirePermission('template:read')

  const { contact, sender } = await withTenant(auth.tenant.id, async () => {
    const contact = await db().contact.findFirst({
      where: { email: { not: null } },
      include: { account: true },
      orderBy: { score: 'desc' },
    })
    return { contact, sender: { name: auth.user.name, email: auth.user.email } }
  })

  const values = contact
    ? valuesFor(contact, sender)
    : valuesFor(
        {
          firstName: 'Priya', lastName: 'Raman', email: 'priya@northwind.io',
          title: 'VP of Sales', city: 'Bengaluru', country: 'India',
          account: { name: 'Northwind Logistics', domain: 'northwind.io', industry: 'Logistics' },
        },
        sender
      )

  const subject = render(input.subject, values)
  const body = render(input.bodyText, values)

  return {
    lint: lintContent({ subject: input.subject, bodyText: input.bodyText, hasUnsubscribe: true }),
    subject: subject.text,
    body: body.text,
    unresolved: [...new Set([...subject.unresolved, ...body.unresolved])],
    unknown: unknownTags(`${input.subject} ${input.bodyText}`),
  }
}
