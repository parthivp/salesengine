'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui'
import { cn } from '@/lib/utils'
import { UserPlus, Copy, Check, AlertTriangle } from 'lucide-react'
import { inviteUser, changeRole, setUserStatus } from './actions'
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from '@/lib/rbac'
import type { UserRole } from '@prisma/client'

const ROLES: UserRole[] = ['owner', 'admin', 'manager', 'rep']

export function InvitePanel({
  seatsUsed,
  seatLimit,
  canInviteOwner,
}: {
  seatsUsed: number
  seatLimit: number
  canInviteOwner: boolean
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<UserRole>('rep')
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<{ url: string; message: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()

  const full = seatsUsed >= seatLimit

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setInvite(null)
    startTransition(async () => {
      const r = await inviteUser({ email, name, role })
      if (!r.ok) setError(r.error)
      else if (r.inviteUrl) {
        setInvite({ url: r.inviteUrl, message: r.message ?? '' })
        setEmail('')
        setName('')
      }
    })
  }

  async function copy() {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy — select the link and copy it manually.')
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus className="h-4 w-4 text-ink-400" />
        <h2 className="text-sm font-semibold text-ink-900">Invite someone</h2>
      </div>
      <p className="text-xs text-ink-500 mb-4">
        {seatsUsed} of {seatLimit} seats used. Invited users hold a seat before they accept.
      </p>

      {full && (
        <p className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          Every seat is taken. Disable a user or raise the limit in Settings first.
        </p>
      )}

      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="teammate@yourcompany.com"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 outline-none transition"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 outline-none transition"
          />
        </label>

        <div>
          <span className="block text-xs font-medium text-ink-600 mb-1">Role</span>
          <div className="space-y-1">
            {ROLES.filter((r) => r !== 'owner' || canInviteOwner).map((r) => (
              <label
                key={r}
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition',
                  role === r ? 'border-brand-400 bg-brand-50/50' : 'border-ink-200 hover:bg-ink-50'
                )}
              >
                <input
                  type="radio"
                  name="role"
                  checked={role === r}
                  onChange={() => setRole(r)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-xs font-medium text-ink-800">{ROLE_LABELS[r]}</span>
                  <span className="block text-xs text-ink-500">{ROLE_DESCRIPTIONS[r]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || full || !email || !name}
          className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {pending ? 'Creating…' : 'Create invitation'}
        </button>
      </form>

      {invite && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
          <p className="text-xs text-emerald-900">{invite.message}</p>
          {/* The link is shown rather than emailed: sending it would go through the
              same sequence mailboxes that are reputation-managed and possibly
              warming, and an invite bouncing off a warm-up cap is a bad first
              impression of the product. */}
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded bg-white border border-emerald-200 px-2 py-1 text-[11px] font-mono text-ink-700">
              {invite.url}
            </code>
            <button
              onClick={copy}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-1 text-xs hover:bg-emerald-50 transition"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-emerald-800">
            Send it to them yourself. It is shown once — reopen this page to issue a new one.
          </p>
        </div>
      )}
    </Card>
  )
}

export function UserControls({
  userId,
  name,
  role,
  status,
  isSelf,
  canManageOwners,
}: {
  userId: string
  name: string
  role: UserRole
  status: string
  isSelf: boolean
  canManageOwners: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function pickRole(next: UserRole) {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const r = await changeRole({ userId, role: next })
      if (!r.ok) setError(r.error)
      else setNote(r.message ?? 'Updated')
    })
  }

  function toggle() {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const r = await setUserStatus(userId, status !== 'disabled')
      if (!r.ok) setError(r.error)
      else setNote(r.message ?? 'Updated')
    })
  }

  if (isSelf) {
    return <span className="text-xs text-ink-400">That is you</span>
  }

  return (
    <div className={cn('text-right', pending && 'opacity-60')}>
      <div className="flex items-center justify-end gap-1.5 flex-wrap">
        <select
          value={role}
          onChange={(e) => pickRole(e.target.value as UserRole)}
          disabled={pending || (role === 'owner' && !canManageOwners)}
          className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs disabled:opacity-50"
        >
          {ROLES.filter((r) => r !== 'owner' || canManageOwners || role === 'owner').map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button
          onClick={toggle}
          disabled={pending}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50 disabled:opacity-50 transition"
        >
          {status === 'disabled' ? 'Re-enable' : 'Disable'}
        </button>
      </div>
      {note && <p className="mt-1 text-xs text-emerald-700">{note}</p>}
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      <span className="sr-only">{name}</span>
    </div>
  )
}
