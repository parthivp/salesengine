'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { checkDomainAuth, maySend, type AuthCheck } from '@/lib/email/deliverability'
import { domainFromEmail } from '@/lib/utils'
import { audit } from '@/lib/audit'
import { warmupCap } from '@/lib/email/schedule'

export type MailboxResult =
  | { ok: true; auth?: AuthCheck; blockers?: string[] }
  | { ok: false; error: string }

const addSchema = z.object({
  email: z.string().email(),
  fromName: z.string().trim().min(1).max(120),
  warmupTarget: z.number().int().min(20).max(2000).default(200),
})

export async function addMailbox(input: z.input<typeof addSchema>): Promise<MailboxResult> {
  const auth = await requirePermission('mailbox:create')
  const parsed = addSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

  const d = parsed.data
  const domain = domainFromEmail(d.email)
  if (!domain) return { ok: false, error: 'Could not read a domain from that address.' }

  // Check DNS before creating the row, so a mailbox is never created in a state
  // where the app believes it can send but receivers will reject.
  const dns = await checkDomainAuth(domain)
  const verdict = maySend(dns)

  try {
    await withTenant(auth.tenant.id, async () => {
      const existing = await db().mailbox.findFirst({ where: { email: d.email } })
      const payload = {
        provider: 'ses' as const,
        fromName: d.fromName,
        spfOk: dns.spf.ok,
        dkimOk: dns.dkim.ok,
        dmarcOk: dns.dmarc.ok,
        lastCheckedAt: new Date(),
        warmupTarget: d.warmupTarget,
        // A mailbox that fails SPF or DKIM is created but blocked. The scheduler
        // skips blocked mailboxes, so nothing can send until DNS is fixed.
        health: verdict.allowed ? ('warming' as const) : ('blocked' as const),
        dailyCap: warmupCap(0, d.warmupTarget),
      }

      if (existing) {
        await db().mailbox.update({ where: { id: existing.id }, data: payload })
      } else {
        await db().mailbox.create({ data: { tenantId: tid(), email: d.email, ...payload } })
      }

      await audit({
        actorId: auth.user.id, action: 'connect', entity: 'Mailbox',
        after: { email: d.email, spf: dns.spf.ok, dkim: dns.dkim.ok, dmarc: dns.dmarc.ok },
      })
    })

    revalidatePath('/admin/mailboxes')
    return { ok: true, auth: dns, blockers: verdict.blockers }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add the mailbox.' }
  }
}

export async function recheckMailbox(mailboxId: string): Promise<MailboxResult> {
  const auth = await requirePermission('mailbox:update')

  try {
    const result = await withTenant(auth.tenant.id, async () => {
      const mailbox = await db().mailbox.findUniqueOrThrow({ where: { id: mailboxId } })
      const domain = domainFromEmail(mailbox.email)
      if (!domain) throw new Error('Mailbox has no usable domain.')
      return { mailbox, domain }
    })

    const dns = await checkDomainAuth(result.domain)
    const verdict = maySend(dns)

    await withTenant(auth.tenant.id, async () => {
      await db().mailbox.update({
        where: { id: mailboxId },
        data: {
          spfOk: dns.spf.ok,
          dkimOk: dns.dkim.ok,
          dmarcOk: dns.dmarc.ok,
          lastCheckedAt: new Date(),
          // Recovering from 'throttled' needs a human decision — DNS passing again
          // does not undo a complaint-rate problem.
          health:
            !verdict.allowed ? 'blocked'
            : result.mailbox.health === 'blocked' ? 'warming'
            : result.mailbox.health,
        },
      })
    })

    revalidatePath('/admin/mailboxes')
    return { ok: true, auth: dns, blockers: verdict.blockers }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Check failed.' }
  }
}
