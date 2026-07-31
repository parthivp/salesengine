'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui'
import { cn } from '@/lib/utils'
import { RefreshCw, Plus } from 'lucide-react'
import {
  addMailbox, recheckMailbox, configureImap, disableImap,
  configureGraph, disableGraph, type MailboxResult,
} from './actions'

export function AddMailbox() {
  const [email, setEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [target, setTarget] = useState(200)
  const [result, setResult] = useState<MailboxResult | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setResult(null)
    startTransition(async () => {
      setResult(await addMailbox({ email, fromName, warmupTarget: target }))
    })
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-ink-200">
        <h2 className="text-sm font-semibold text-ink-900">Add a mailbox</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          DNS is checked before the mailbox is created.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <div>
          <label htmlFor="mb-email" className="block text-xs font-medium text-ink-600 mb-1">
            Sending address
          </label>
          <input
            id="mb-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="outbound@yourdomain.com"
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>
        <div>
          <label htmlFor="mb-name" className="block text-xs font-medium text-ink-600 mb-1">
            From name
          </label>
          <input
            id="mb-name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Rohan Desai"
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>
        <div>
          <label htmlFor="mb-target" className="block text-xs font-medium text-ink-600 mb-1">
            Daily cap once warm
          </label>
          <input
            id="mb-target"
            type="number"
            min={20}
            max={2000}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>

        <button
          onClick={submit}
          disabled={pending || !email.includes('@') || fromName.trim().length < 1}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
        >
          <Plus className="h-4 w-4" />
          {pending ? 'Checking DNS…' : 'Add mailbox'}
        </button>

        {result && !result.ok && (
          <p role="alert" className="text-xs text-red-700">{result.error}</p>
        )}
        {result?.ok && (
          <div className="text-xs space-y-1">
            <p className="text-ink-700">
              SPF {result.auth?.spf.ok ? '✓' : '✗'} · DKIM {result.auth?.dkim.ok ? '✓' : '✗'} ·
              DMARC {result.auth?.dmarc.ok ? '✓' : '✗'}
            </p>
            {result.blockers?.length ? (
              <>
                <p className="text-red-700 font-medium">
                  Added, but blocked from sending until these are fixed:
                </p>
                <ul className="list-disc list-inside text-red-700">
                  {result.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </>
            ) : (
              <p className="text-emerald-700">
                Added and warming. Starts at 20/day and ramps weekly.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

export function RecheckButton({ mailboxId }: { mailboxId: string }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(async () => { await recheckMailbox(mailboxId) })}
      disabled={pending}
      title="Re-check SPF, DKIM and DMARC"
      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition shrink-0"
    >
      <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
      {pending ? 'Checking' : 'Re-check'}
    </button>
  )
}

/**
 * Reply polling settings for one mailbox.
 *
 * The password field is write-only by design: the form can say whether IMAP is
 * configured and for which user, never what the secret is. Rendering a stored
 * mailbox password back into a browser is a full account takeover one screenshot
 * away, and "so the user can check it" is not worth that.
 */
export function ImapPanel({
  mailboxId,
  email,
  configured,
  user,
  host,
  lastPolledAt,
  lastError,
}: {
  mailboxId: string
  email: string
  configured: boolean
  user?: string | null
  host?: string | null
  lastPolledAt?: string | null
  lastError?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    host: host ?? guessHost(email),
    port: '993',
    user: user ?? email,
    password: '',
    mailbox: 'INBOX',
  })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }))
      setSaved(false)
    }
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const r = await configureImap({
        mailboxId,
        host: form.host,
        port: Number(form.port) || 993,
        user: form.user,
        password: form.password,
        mailbox: form.mailbox,
      })
      if (!r.ok) setError(r.error)
      else {
        setSaved(true)
        setOpen(false)
        setForm((f) => ({ ...f, password: '' }))
      }
    })
  }

  function turnOff() {
    setError(null)
    startTransition(async () => {
      const r = await disableImap(mailboxId)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50/40 p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-800">
            Reply polling{' '}
            {configured ? (
              <span className="text-emerald-700">on</span>
            ) : (
              <span className="text-amber-800">off — replies will not be detected</span>
            )}
          </p>
          {configured && (
            <p className="text-xs text-ink-500 mt-0.5">
              {host} as {user}
              {lastPolledAt ? ` · last polled ${lastPolledAt}` : ' · not polled yet'}
            </p>
          )}
          {lastError && <p className="mt-0.5 text-xs text-red-700">{lastError}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 transition"
          >
            {configured ? 'Change' : 'Set up'}
          </button>
          {configured && (
            <button
              onClick={turnOff}
              disabled={pending}
              className="rounded-md px-2.5 py-1.5 text-xs text-ink-500 hover:bg-ink-100 disabled:opacity-50 transition"
            >
              Turn off
            </button>
          )}
        </div>
      </div>

      {saved && <p className="mt-2 text-xs text-emerald-700">Saved. The next poll runs within a few minutes.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}

      {open && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Field label="IMAP host" value={form.host} onChange={set('host')} placeholder="imap.gmail.com" />
          <Field label="Port" value={form.port} onChange={set('port')} placeholder="993" />
          <Field label="Username" value={form.user} onChange={set('user')} placeholder={email} />
          <Field
            label="Password or app password"
            value={form.password}
            onChange={set('password')}
            type="password"
            placeholder="write-only"
          />
          <Field label="Folder" value={form.mailbox} onChange={set('mailbox')} placeholder="INBOX" />
          <div className="flex items-end">
            <button
              onClick={save}
              disabled={pending || !form.host || !form.user || !form.password}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p className="sm:col-span-2 text-xs text-ink-400">
            Gmail and Outlook require an app password rather than your account password when
            two-factor authentication is on. Polling starts from the newest message, so existing mail
            is not ingested.
          </p>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-600 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none transition"
      />
    </label>
  )
}

/** Saves a round-trip for the two providers almost everyone actually uses. */
function guessHost(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (/gmail\.com|googlemail\.com/.test(domain)) return 'imap.gmail.com'
  if (/outlook\.|hotmail\.|live\.|office365|microsoft/.test(domain)) return 'outlook.office365.com'
  if (/yahoo\./.test(domain)) return 'imap.mail.yahoo.com'
  if (/zoho\./.test(domain)) return 'imap.zoho.com'
  return domain ? `imap.${domain}` : ''
}

/**
 * Microsoft 365 reply collection, through Graph.
 *
 * A separate panel from the IMAP one rather than a mode of it, because the two
 * ask for entirely different things and mixing them produces a form where half
 * the fields are always irrelevant. Which one a mailbox uses is decided by its
 * provider, not by a toggle the operator has to reason about.
 */
export function GraphPanel({
  mailboxId,
  email,
  configured,
  clientId,
  entraTenantId,
  lastPolledAt,
  lastError,
}: {
  mailboxId: string
  email: string
  configured: boolean
  clientId?: string | null
  entraTenantId?: string | null
  lastPolledAt?: string | null
  lastError?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    tenantId: entraTenantId ?? '',
    clientId: clientId ?? '',
    clientSecret: '',
    mailbox: email,
  })
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }))
      setOk(null)
    }
  }

  function save() {
    setError(null)
    setOk(null)
    startTransition(async () => {
      const r = await configureGraph({ mailboxId, ...form })
      if (!r.ok) setError(r.error)
      else {
        setOk(r.blockers?.[0] ?? 'Connected.')
        setOpen(false)
        setForm((f) => ({ ...f, clientSecret: '' }))
      }
    })
  }

  function turnOff() {
    setError(null)
    startTransition(async () => {
      const r = await disableGraph(mailboxId)
      if (!r.ok) setError(r.error)
      else setOk('Disconnected.')
    })
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50/40 p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-800">
            Microsoft 365 reply collection{' '}
            {configured ? (
              <span className="text-emerald-700">on</span>
            ) : (
              <span className="text-amber-800">off — replies will not be detected</span>
            )}
          </p>
          {configured && (
            <p className="text-xs text-ink-500 mt-0.5">
              App {clientId?.slice(0, 8)}… reading {email}
              {lastPolledAt ? ` · last polled ${lastPolledAt}` : ' · not polled yet'}
            </p>
          )}
          {lastError && <p className="mt-0.5 text-xs text-red-700">{lastError}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 transition"
          >
            {configured ? 'Change' : 'Connect'}
          </button>
          {configured && (
            <button
              onClick={turnOff}
              disabled={pending}
              className="rounded-md px-2.5 py-1.5 text-xs text-ink-500 hover:bg-ink-100 disabled:opacity-50 transition"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {ok && <p className="mt-2 text-xs text-emerald-700">{ok}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}

      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-500">
            From your Entra app registration. IMAP is not an option on Microsoft 365 — Basic
            authentication is permanently disabled there, so this uses Graph instead.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Directory (tenant) ID" value={form.tenantId} onChange={set('tenantId')}
                   placeholder="00000000-0000-0000-0000-000000000000" />
            <Field label="Application (client) ID" value={form.clientId} onChange={set('clientId')}
                   placeholder="00000000-0000-0000-0000-000000000000" />
            <Field label="Client secret value" value={form.clientSecret} onChange={set('clientSecret')}
                   type="password" placeholder="write-only" />
            <Field label="Mailbox to read" value={form.mailbox} onChange={set('mailbox')}
                   placeholder={email} />
          </div>
          <button
            onClick={save}
            disabled={pending || !form.tenantId || !form.clientId || !form.clientSecret || !form.mailbox}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {pending ? 'Verifying…' : 'Verify and connect'}
          </button>
          <p className="text-xs text-ink-400">
            The credentials are checked against Graph before anything is saved, and the secret is
            encrypted and never shown again. Polling starts from the next message, so existing mail
            is not ingested.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Chooses which reply transport a mailbox uses.
 *
 * Guessing from the address does not work: a Microsoft 365 tenant on a custom
 * domain looks exactly like any other domain, and the `provider` column already
 * means something else — how mail is *sent*, which is SES regardless. So this
 * asks, once, and then shows only the panel that applies.
 */
export function ReplyTransport({
  mailboxId,
  email,
  imapConfigured,
  graphConfigured,
  imapHost,
  imapUser,
  graphClientId,
  graphTenantId,
  lastPolledAt,
  lastError,
}: {
  mailboxId: string
  email: string
  imapConfigured: boolean
  graphConfigured: boolean
  imapHost?: string | null
  imapUser?: string | null
  graphClientId?: string | null
  graphTenantId?: string | null
  lastPolledAt?: string | null
  lastError?: string | null
}) {
  const [choice, setChoice] = useState<'graph' | 'imap'>(
    graphConfigured ? 'graph' : imapConfigured ? 'imap' : 'graph'
  )

  const configured = graphConfigured || imapConfigured

  return (
    <div className="mt-3">
      {!configured && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-ink-500">Replies arrive via:</span>
          {(
            [
              ['graph', 'Microsoft 365'],
              ['imap', 'IMAP (Gmail, Zoho, custom)'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setChoice(value)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition',
                choice === value
                  ? 'border-brand-400 bg-brand-50 text-brand-800 font-medium'
                  : 'border-ink-200 hover:bg-ink-50'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {choice === 'graph' ? (
        <GraphPanel
          mailboxId={mailboxId}
          email={email}
          configured={graphConfigured}
          clientId={graphClientId}
          entraTenantId={graphTenantId}
          lastPolledAt={lastPolledAt}
          lastError={lastError}
        />
      ) : (
        <ImapPanel
          mailboxId={mailboxId}
          email={email}
          configured={imapConfigured}
          host={imapHost}
          user={imapUser}
          lastPolledAt={lastPolledAt}
          lastError={lastError}
        />
      )}
    </div>
  )
}
