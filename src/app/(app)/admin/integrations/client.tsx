'use client'

import { useState, useTransition } from 'react'
import { Card, Badge } from '@/components/ui'
import { cn, formatRelative } from '@/lib/utils'
import { Plug, RefreshCw, ArrowRight, ArrowLeft, ArrowLeftRight, Ban, AlertTriangle } from 'lucide-react'
import {
  beginConnect, applyDefaultMappings, setConflictPolicy, toggleSync,
  runSyncNow, resolveConflictRecord, validateConnectionMappings,
} from './actions'

const POLICIES = [
  { key: 'last_write_wins', label: 'Newest wins', detail: 'Whichever side was edited most recently.' },
  { key: 'crm_wins', label: 'CRM wins', detail: 'The CRM is the system of record.' },
  { key: 'app_wins', label: 'SalesEngine wins', detail: 'This app is the system of record.' },
  { key: 'manual', label: 'Ask me', detail: 'Hold both versions for a human to decide.' },
] as const

const DIRECTION_ICON = {
  push: ArrowRight,
  pull: ArrowLeft,
  bidirectional: ArrowLeftRight,
  none: Ban,
} as const

export function ConnectPanel({ configured }: { configured: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function connect() {
    setError(null)
    startTransition(async () => {
      const r = await beginConnect('salesforce')
      if (!r.ok) setError(r.error)
      else if (r.data?.url) window.location.href = r.data.url
    })
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Salesforce</h2>
          <p className="mt-1 text-sm text-ink-500 max-w-lg">
            Bi-directional sync for Accounts, Contacts and Leads, with per-field direction and an
            explicit conflict policy. Activity write-back logs sequenced emails to the CRM timeline.
          </p>
        </div>
        <button
          onClick={connect}
          disabled={pending || !configured}
          title={configured ? undefined : 'Deployment credentials missing'}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition',
            configured
              ? 'bg-brand-600 text-white hover:bg-brand-700'
              : 'bg-ink-100 text-ink-400 cursor-not-allowed'
          )}
        >
          <Plug className="h-4 w-4" />
          {pending ? 'Redirecting…' : 'Connect Salesforce'}
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </Card>
  )
}

export function SyncControls({
  connectionId,
  syncEnabled,
  policy,
  hasMappings,
}: {
  connectionId: string
  syncEnabled: boolean
  policy: (typeof POLICIES)[number]['key']
  hasMappings: boolean
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const r = await fn()
      if (!r.ok) setError(r.error ?? 'Something went wrong.')
      else if (ok) setMessage(ok)
    })
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => act(() => runSyncNow(connectionId), 'Sync queued.')}
          disabled={pending || !hasMappings}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
        >
          <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          Sync now
        </button>
        <button
          onClick={() => act(() => toggleSync(connectionId, !syncEnabled))}
          disabled={pending}
          className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
        >
          {syncEnabled ? 'Pause sync' : 'Resume sync'}
        </button>
      </div>

      <div className="flex flex-wrap justify-end gap-1">
        {POLICIES.map((p) => (
          <button
            key={p.key}
            onClick={() => act(() => setConflictPolicy(connectionId, p.key))}
            disabled={pending}
            title={p.detail}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium transition',
              policy === p.key
                ? 'bg-brand-600 text-white'
                : 'bg-white border border-ink-200 text-ink-600 hover:bg-ink-50'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {message && <p className="text-xs text-emerald-700">{message}</p>}
      {error && <p className="text-xs text-red-700 max-w-xs text-right">{error}</p>}
      {!hasMappings && (
        <p className="text-xs text-amber-700">Map fields before syncing.</p>
      )}
    </div>
  )
}

export function MappingTable({
  connectionId,
  mappings,
}: {
  connectionId: string
  mappings: {
    id: string
    object: string
    localField: string
    remoteField: string
    direction: string
    transform: string | null
  }[]
}) {
  const [problems, setProblems] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function applyDefaults() {
    setError(null)
    startTransition(async () => {
      const r = await applyDefaultMappings(connectionId)
      if (!r.ok) setError(r.error)
    })
  }

  function validate() {
    setError(null)
    startTransition(async () => {
      const r = await validateConnectionMappings(connectionId)
      if (!r.ok) setError(r.error)
      else setProblems(r.data?.problems ?? [])
    })
  }

  const byObject = mappings.reduce<Record<string, typeof mappings>>((acc, m) => {
    acc[m.object] = [...(acc[m.object] ?? []), m]
    return acc
  }, {})

  return (
    <div>
      <div className="px-5 py-3 flex items-center justify-between gap-3 border-b border-ink-100">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Field mappings <span className="text-ink-400 font-normal">({mappings.length})</span>
          </h3>
          <p className="text-xs text-ink-500">
            Direction is per field, so a CRM-owned field can be read-only while ours pushes.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={validate}
            disabled={pending || !mappings.length}
            className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
          >
            Validate
          </button>
          <button
            onClick={applyDefaults}
            disabled={pending}
            className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
          >
            {pending ? 'Working…' : 'Apply defaults'}
          </button>
        </div>
      </div>

      {error && <p className="px-5 py-2 text-xs text-red-700">{error}</p>}

      {problems && (
        <div className="px-5 py-3 border-b border-ink-100">
          {problems.length === 0 ? (
            <p className="text-xs text-emerald-700">No mapping problems found.</p>
          ) : (
            <ul className="space-y-1">
              {problems.map((p, i) => (
                <li key={i} className="text-xs text-amber-800 flex gap-1.5 items-start">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mappings.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-500">
          No fields mapped yet. “Apply defaults” gives you a sensible Salesforce starting point you
          can then narrow.
        </p>
      ) : (
        <div className="divide-y divide-ink-100">
          {Object.entries(byObject).map(([object, rows]) => (
            <div key={object} className="px-5 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400 mb-2">
                {object}
              </p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {rows.map((m) => {
                  const Icon = DIRECTION_ICON[m.direction as keyof typeof DIRECTION_ICON] ?? ArrowLeftRight
                  return (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      <code className="text-ink-700 truncate">{m.localField}</code>
                      <Icon className="h-3.5 w-3.5 text-ink-400 shrink-0" />
                      <code className="text-brand-700 truncate">{m.remoteField}</code>
                      {m.transform && m.transform !== 'identity' && (
                        <Badge>{m.transform}</Badge>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ConflictList({
  conflicts,
}: {
  conflicts: { id: string; object: string; localId: string; remoteId: string; reason: string; at: string | null }[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function resolve(id: string, winner: 'app' | 'crm') {
    setError(null)
    startTransition(async () => {
      const r = await resolveConflictRecord(id, winner)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-ink-200">
        <h2 className="text-sm font-semibold text-ink-900">
          Conflicts needing a decision{' '}
          <span className="text-ink-400 font-normal">({conflicts.length})</span>
        </h2>
        <p className="mt-0.5 text-xs text-ink-500">
          Both sides changed and the policy could not decide. Neither version is overwritten until
          you choose.
        </p>
      </div>
      {error && <p className="px-5 py-2 text-xs text-red-700">{error}</p>}
      <ul className="divide-y divide-ink-100">
        {conflicts.map((c) => (
          <li key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-ink-900">
                <span className="capitalize">{c.object}</span>{' '}
                <code className="text-xs text-ink-500">{c.remoteId}</code>
              </p>
              <p className="text-xs text-ink-500 truncate">{c.reason}</p>
              {c.at && <p className="text-xs text-ink-400">{formatRelative(new Date(c.at))}</p>}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => resolve(c.id, 'app')}
                disabled={pending}
                className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
              >
                Keep ours
              </button>
              <button
                onClick={() => resolve(c.id, 'crm')}
                disabled={pending}
                className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
              >
                Keep CRM's
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
