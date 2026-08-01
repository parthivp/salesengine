'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { withTenant, db, tid } from '@/lib/db'
import { checkDomainAuth, maySend, type AuthCheck } from '@/lib/email/deliverability'
import { domainFromEmail } from '@/lib/utils'
import { audit } from '@/lib/audit'
import { warmupCap } from '@/lib/email/schedule'
import { seal } from '@/lib/crypto'
import { verifyGraphAccess, graphCredentialsFrom } from '@/lib/email/graph'
import { logger } from '@/lib/logger'

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
  //
  // No `providerSignsDkim` here: a mailbox being created has no transport
  // configured yet. Connecting Microsoft 365 re-runs this via the re-check, which
  // does know.
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
    // Microsoft signs outbound mail from a Graph-connected mailbox with the
    // tenant key, so a missing custom selector is an improvement to make, not a
    // reason to refuse to send.
    const verdict = maySend(dns, {
      providerSignsDkim: Boolean(graphCredentialsFrom(result.mailbox.credentials)),
    })

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

// --- reply polling ----------------------------------------------------------

const imapSchema = z.object({
  mailboxId: z.string().min(1),
  host: z.string().trim().min(3).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  user: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
  mailbox: z.string().trim().max(255).default('INBOX'),
})

/**
 * Stores IMAP details so replies can be pulled in.
 *
 * The password is sealed with AES-256-GCM before it touches the row, and is never
 * read back out to the browser — the UI can see that IMAP is configured and for
 * which user, never the secret. A mailbox password is a full account takeover if
 * it leaks, and "show the current value so the user can check it" is how that
 * happens.
 */
export async function configureImap(input: z.input<typeof imapSchema>): Promise<MailboxResult> {
  const auth = await requirePermission('mailbox:update')
  const parsed = imapSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  const d = parsed.data

  try {
    await withTenant(auth.tenant.id, async () => {
      const mailbox = await db().mailbox.findUniqueOrThrow({ where: { id: d.mailboxId } })
      const credentials = (mailbox.credentials ?? {}) as Record<string, unknown>

      await db().mailbox.update({
        where: { id: d.mailboxId },
        data: {
          credentials: {
            ...credentials,
            imap: {
              host: d.host,
              port: d.port,
              secure: true,
              user: d.user,
              password: seal(d.password),
              mailbox: d.mailbox || 'INBOX',
            },
          } as never,
          // Start from the current end of the folder rather than 0. A first poll
          // of an old mailbox would otherwise ingest years of history, stopping
          // sequences on decade-old threads and filing hundreds of tasks.
          imapLastUid: null,
          imapLastError: null,
          imapLastPolledAt: null,
        },
      })

      await audit({
        actorId: auth.user.id,
        action: 'connect',
        entity: 'Mailbox',
        entityId: d.mailboxId,
        after: { imap: { host: d.host, user: d.user, mailbox: d.mailbox } },
      })
    })

    revalidatePath('/admin/mailboxes')
    revalidatePath('/inbox')
    return { ok: true }
  } catch (err) {
    logger.error({ err, mailboxId: d.mailboxId }, 'could not save IMAP settings')
    return { ok: false, error: 'Could not save those settings.' }
  }
}

/** Removes IMAP details. Replies stop arriving; nothing already ingested changes. */
export async function disableImap(mailboxId: string): Promise<MailboxResult> {
  const auth = await requirePermission('mailbox:update')
  try {
    await withTenant(auth.tenant.id, async () => {
      const mailbox = await db().mailbox.findUniqueOrThrow({ where: { id: mailboxId } })
      const credentials = { ...((mailbox.credentials ?? {}) as Record<string, unknown>) }
      delete credentials.imap
      await db().mailbox.update({
        where: { id: mailboxId },
        data: { credentials: credentials as never, imapLastError: null },
      })
      await audit({
        actorId: auth.user.id, action: 'disconnect', entity: 'Mailbox', entityId: mailboxId,
      })
    })
    revalidatePath('/admin/mailboxes')
    return { ok: true }
  } catch (err) {
    logger.error({ err, mailboxId }, 'could not disable IMAP')
    return { ok: false, error: 'Could not disable reply polling.' }
  }
}

// --- Microsoft Graph --------------------------------------------------------

const graphSchema = z.object({
  mailboxId: z.string().min(1),
  tenantId: z.string().trim().min(10).max(100),
  clientId: z.string().trim().min(10).max(100),
  clientSecret: z.string().min(1).max(1024),
  mailbox: z.string().trim().email(),
})

/**
 * Connects a Microsoft 365 mailbox for reply collection.
 *
 * Graph rather than IMAP because Basic authentication for IMAP is permanently
 * disabled in every Exchange Online tenant — Microsoft's documentation is explicit
 * that neither the tenant admin nor Microsoft support can turn it back on. A
 * username and password cannot reach an M365 mailbox at all.
 *
 * Credentials are verified against Graph before being stored. The two ways this
 * fails need completely different fixes and are easy to confuse: a wrong secret
 * fails at Entra, while a missing Application Access Policy authenticates
 * perfectly and then returns 403 on the mailbox.
 */
export async function configureGraph(input: z.input<typeof graphSchema>): Promise<MailboxResult> {
  const auth = await requirePermission('mailbox:update')
  const parsed = graphSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  const d = parsed.data

  const check = await verifyGraphAccess({
    tenantId: d.tenantId,
    clientId: d.clientId,
    clientSecret: d.clientSecret,
    mailbox: d.mailbox,
  })
  if (!check.ok) return { ok: false, error: check.error }

  try {
    await withTenant(auth.tenant.id, async () => {
      const mailbox = await db().mailbox.findUniqueOrThrow({ where: { id: d.mailboxId } })
      const credentials = { ...((mailbox.credentials ?? {}) as Record<string, unknown>) }

      // Drop any IMAP config on the same mailbox. Leaving it would be a set of
      // credentials that cannot possibly work, waiting to confuse whoever reads
      // this row next.
      delete credentials.imap

      await db().mailbox.update({
        where: { id: d.mailboxId },
        data: {
          provider: 'outlook',
          credentials: {
            ...credentials,
            graph: {
              tenantId: d.tenantId,
              clientId: d.clientId,
              clientSecret: seal(d.clientSecret),
              mailbox: d.mailbox,
            },
          } as never,
          // Start from the next poll, not the beginning of the mailbox.
          graphDeltaLink: null,
          imapLastUid: null,
          imapLastError: null,
          imapLastPolledAt: null,
        },
      })

      await audit({
        actorId: auth.user.id,
        action: 'connect',
        entity: 'Mailbox',
        entityId: d.mailboxId,
        after: { graph: { tenantId: d.tenantId, clientId: d.clientId, mailbox: d.mailbox } },
      })
    })

    revalidatePath('/admin/mailboxes')
    revalidatePath('/inbox')
    // Reported at connect time, not at the first send. An operator who adds
    // Mail.Read and forgets Mail.Send has a mailbox that polls replies perfectly
    // and silently sends nothing — and finds out three days into a campaign.
    const notes = [`Connected as ${check.result.displayName}.`]
    if (!check.result.canSend) {
      notes.push(
        'Read-only: Mail.Send was not granted, so sequences from this mailbox will be ' +
          'logged rather than sent. Add the Mail.Send application permission in Entra and ' +
          'grant admin consent, then reconnect. Reply and connection-acceptance tracking ' +
          'work without it.'
      )
    }
    return { ok: true, blockers: notes }
  } catch (err) {
    logger.error({ err, mailboxId: d.mailboxId }, 'could not save Graph settings')
    return { ok: false, error: 'Verified, but could not save those settings.' }
  }
}

/** Removes Graph credentials. Replies stop arriving; nothing ingested changes. */
export async function disableGraph(mailboxId: string): Promise<MailboxResult> {
  const auth = await requirePermission('mailbox:update')
  try {
    await withTenant(auth.tenant.id, async () => {
      const mailbox = await db().mailbox.findUniqueOrThrow({ where: { id: mailboxId } })
      const credentials = { ...((mailbox.credentials ?? {}) as Record<string, unknown>) }
      delete credentials.graph
      await db().mailbox.update({
        where: { id: mailboxId },
        data: { credentials: credentials as never, graphDeltaLink: null, imapLastError: null },
      })
      await audit({
        actorId: auth.user.id, action: 'disconnect', entity: 'Mailbox', entityId: mailboxId,
      })
    })
    revalidatePath('/admin/mailboxes')
    return { ok: true }
  } catch (err) {
    logger.error({ err, mailboxId }, 'could not disable Graph')
    return { ok: false, error: 'Could not disconnect.' }
  }
}
