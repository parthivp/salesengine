import { pagePermission } from '@/lib/auth'
import { withTenant, db } from '@/lib/db'
import { PageHeader, Card, Badge, EmptyState, AccessDenied } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/rbac'
import { formatNumber, formatRelative } from '@/lib/utils'
import { assessReputation, REPUTATION_LIMITS } from '@/lib/email/deliverability'
import { sendingEnabled } from '@/lib/email/send'
import { Mail, ShieldCheck, ShieldAlert } from 'lucide-react'
import { AddMailbox, RecheckButton, ReplyTransport } from './client'
import type { MailboxHealth } from '@prisma/client'

export const metadata = { title: 'Mailboxes · SalesEngine' }
export const dynamic = 'force-dynamic'

const HEALTH_TONE: Record<MailboxHealth, 'success' | 'warning' | 'danger' | 'neutral'> = {
  healthy: 'success',
  warming: 'warning',
  throttled: 'danger',
  blocked: 'danger',
  disconnected: 'neutral',
}

export default async function MailboxesPage() {
  const guard = await pagePermission('admin:access')
  if (!guard.ok) {
    return (
      <>
        <PageHeader title="Mailboxes" />
        <AccessDenied what="Mailbox administration" role={ROLE_LABELS[guard.role]} />
      </>
    )
  }
  const auth = guard.auth

  const mailboxes = await withTenant(auth.tenant.id, async () => {
    const rows = await db().mailbox.findMany({ orderBy: { createdAt: 'asc' } })
    return Promise.all(
      rows.map(async (m) => {
        const [sent, bounced, complained] = await Promise.all([
          db().emailMessage.count({ where: { mailboxId: m.id, sentAt: { not: null } } }),
          db().emailMessage.count({ where: { mailboxId: m.id, status: 'bounced' } }),
          db().emailMessage.count({ where: { mailboxId: m.id, status: 'complained' } }),
        ])
        // Only the non-secret parts of the credential blob reach the client. The
        // sealed password stays on the server; a mailbox password rendered into a
        // page is an account takeover one screenshot away.
        const creds = m.credentials as {
          imap?: { host?: string; user?: string }
          graph?: { clientId?: string; tenantId?: string }
        } | null
        const imapRaw = creds?.imap
        const imap = imapRaw?.host ? { host: imapRaw.host, user: imapRaw.user ?? null } : null
        const graphRaw = creds?.graph
        const graph = graphRaw?.clientId
          ? { clientId: graphRaw.clientId, tenantId: graphRaw.tenantId ?? null }
          : null
        const { credentials: _credentials, ...safe } = m
        return {
          ...safe,
          imap,
          stats: { sent, bounced, complained },
          graph,
          verdict: assessReputation({ sent, bounced, complained }),
        }
      })
    )
  })

  const live = sendingEnabled()

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Sending identities, their authentication status and their reputation."
      />

      <Card className="mb-6 p-4">
        <div className="flex items-start gap-3">
          {live ? (
            <ShieldAlert className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
          ) : (
            <ShieldCheck className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
          )}
          <div>
            <p className="text-sm font-medium text-ink-900">
              {live ? 'Live sending is armed' : 'Live sending is disabled'}
            </p>
            <p className="mt-0.5 text-sm text-ink-500">
              {live
                ? 'EMAIL_TRANSPORT resolves to SES, so activating a sequence will send real email.'
                : 'EMAIL_TRANSPORT is set to “log”, so the engine runs end to end but nothing leaves the server. Set it to “ses” or “auto” with AWS credentials to send for real.'}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <div className="px-5 py-4 border-b border-ink-200">
              <h2 className="text-sm font-semibold text-ink-900">
                Connected <span className="text-ink-400 font-normal">({mailboxes.length})</span>
              </h2>
            </div>

            {mailboxes.length === 0 ? (
              <EmptyState
                icon={Mail}
                title="No mailboxes connected"
                description="A sequence cannot be activated until at least one mailbox passes SPF and DKIM."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {mailboxes.map((m) => {
                  const bounceRate = m.stats.sent ? m.stats.bounced / m.stats.sent : 0
                  const complaintRate = m.stats.sent ? m.stats.complained / m.stats.sent : 0
                  return (
                    <li key={m.id} className="px-5 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-ink-900">{m.email}</p>
                            <Badge tone={HEALTH_TONE[m.health]}>{m.health}</Badge>
                            <Badge>{m.provider}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-ink-500">
                            From “{m.fromName}” · checked {formatRelative(m.lastCheckedAt)}
                          </p>

                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <AuthPill ok={m.spfOk} label="SPF" />
                            <AuthPill ok={m.dkimOk} label="DKIM" />
                            <AuthPill ok={m.dmarcOk} label="DMARC" advisory />
                          </div>

                          <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <Stat label="Sent" value={formatNumber(m.stats.sent)} />
                            <Stat
                              label="Today"
                              value={`${formatNumber(m.sentToday)} / ${formatNumber(m.dailyCap)}`}
                            />
                            <Stat
                              label="Bounce"
                              value={`${(bounceRate * 100).toFixed(1)}%`}
                              bad={bounceRate >= REPUTATION_LIMITS.bounceWarn}
                            />
                            <Stat
                              label="Complaint"
                              value={`${(complaintRate * 100).toFixed(3)}%`}
                              bad={complaintRate >= REPUTATION_LIMITS.complaintWarn}
                            />
                          </dl>

                          {m.health === 'warming' && (
                            <p className="mt-2 text-xs text-amber-700">
                              Warming: day {m.warmupDay}, cap {m.dailyCap}/day, ramping to{' '}
                              {m.warmupTarget}. Slow starts are what keep a new domain out of spam.
                            </p>
                          )}
                          {m.verdict.action !== 'ok' && (
                            <ul className="mt-2 space-y-0.5">
                              {m.verdict.reasons.map((r, i) => (
                                <li key={i} className="text-xs text-red-700">{r}</li>
                              ))}
                            </ul>
                          )}
                          {m.health === 'blocked' && (
                            <p className="mt-2 text-xs text-red-700">
                              Blocked from sending until SPF and DKIM pass. Fix the DNS records, then
                              re-check.
                            </p>
                          )}
                        </div>

                        <RecheckButton mailboxId={m.id} />
                      </div>

                      <ReplyTransport
                        mailboxId={m.id}
                        email={m.email}
                        imapConfigured={Boolean(m.imap)}
                        graphConfigured={Boolean(m.graph)}
                        imapHost={m.imap?.host ?? null}
                        imapUser={m.imap?.user ?? null}
                        graphClientId={m.graph?.clientId ?? null}
                        graphTenantId={m.graph?.tenantId ?? null}
                        lastPolledAt={m.imapLastPolledAt ? formatRelative(m.imapLastPolledAt) : null}
                        lastError={m.imapLastError}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <AddMailbox />

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900 mb-2">Why this is strict</h2>
            <p className="text-sm text-ink-600 leading-relaxed">
              A mailbox that fails SPF or DKIM is created but blocked, and the scheduler skips it.
              Sending unauthenticated cold email is the fastest way to burn a domain, and a burned
              domain takes months to recover — far longer than fixing two DNS records.
            </p>
            <p className="mt-3 text-sm text-ink-600 leading-relaxed">
              AWS suspends accounts above a 5% bounce rate or 0.1% complaint rate. We pause a mailbox
              before either threshold, because pausing ourselves is always cheaper than being paused.
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}

function AuthPill({ ok, label, advisory }: { ok: boolean; label: string; advisory?: boolean }) {
  return (
    <span
      className={
        ok
          ? 'inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700'
          : advisory
            ? 'inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700'
            : 'inline-flex items-center rounded-md bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700'
      }
      title={advisory && !ok ? 'DMARC is advisory — sending is still allowed' : undefined}
    >
      {label} {ok ? '✓' : '✗'}
    </span>
  )
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div>
      <dt className="text-ink-400">{label}</dt>
      <dd className={bad ? 'font-medium text-red-700 tabular-nums' : 'font-medium text-ink-900 tabular-nums'}>
        {value}
      </dd>
    </div>
  )
}
