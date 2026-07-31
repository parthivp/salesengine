'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import Papa from 'papaparse'
import { Card, Badge } from '@/components/ui'
import { cn, formatNumber } from '@/lib/utils'
import {
  ExternalLink, Copy, Check, SkipForward, UserCheck, Ban,
  Upload, FileSpreadsheet, AlertTriangle, ListPlus,
} from 'lucide-react'
import { record, buildTargetList, runSalesNavImport } from './actions'
import { SALESNAV_FIELDS, SALESNAV_ALIASES } from '@/lib/linkedin/fields'

type Check = { severity: string; message: string }

export type Card = {
  taskId: string
  contactId: string
  action: string
  name: string
  title: string | null
  company: string | null
  profileUrl: string | null
  score: number
  text: string
  limit: number
  generic: boolean
  usedHooks: string[]
  checks: Check[]
  rationale: string[]
}

export function QueueCards({ cards, canSend }: { cards: Card[]; canSend: boolean }) {
  return (
    <ul className="space-y-4">
      {cards.map((c) => (
        <QueueCard key={c.taskId} card={c} canSend={canSend} />
      ))}
    </ul>
  )
}

function QueueCard({ card, canSend }: { card: Card; canSend: boolean }) {
  const [text, setText] = useState(card.text)
  const [copied, setCopied] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const over = text.trim().length > card.limit
  const blocking = card.checks.some((c) => c.severity === 'error') || over

  function act(outcome: 'sent' | 'skipped' | 'already_connected' | 'not_a_fit') {
    setError(null)
    startTransition(async () => {
      const r = await record({
        taskId: card.taskId,
        outcome,
        finalText: outcome === 'sent' ? text : undefined,
      })
      if (!r.ok) setError(r.error)
      else setDone(outcome)
    })
  }

  async function copyAndOpen() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked; the textarea is still selectable, so this is
      // a convenience rather than the only path.
      setError('Could not copy automatically — select the text and copy it.')
    }
    if (card.profileUrl) window.open(card.profileUrl, '_blank', 'noopener,noreferrer')
  }

  if (done) {
    return (
      <li className="rounded-xl border border-emerald-200 bg-emerald-50/50 px-5 py-3 text-sm text-emerald-800 flex items-center gap-2">
        <Check className="h-4 w-4" />
        {card.name} — recorded as {done.replace(/_/g, ' ')}
      </li>
    )
  }

  return (
    <li className={cn('rounded-xl border border-ink-200 bg-white', pending && 'opacity-60')}>
      <div className="px-5 py-4 border-b border-ink-100 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/contacts/${card.contactId}`}
              className="text-sm font-semibold text-ink-900 hover:text-brand-700"
            >
              {card.name}
            </Link>
            <Badge tone={card.score >= 60 ? 'success' : card.score >= 30 ? 'warning' : 'neutral'}>
              score {card.score}
            </Badge>
            <Badge tone="brand">{card.action}</Badge>
            {card.generic && <Badge tone="warning">generic</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            {[card.title, card.company].filter(Boolean).join(' · ') || '—'}
          </p>
          {card.rationale.length > 0 && (
            <p className="mt-1 text-xs text-ink-400">Why: {card.rationale.join(' · ')}</p>
          )}
        </div>

        {card.profileUrl && (
          <a
            href={card.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 transition shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Profile
          </a>
        )}
      </div>

      <div className="p-5">
        <label htmlFor={`draft-${card.taskId}`} className="block text-xs font-medium text-ink-600 mb-1.5">
          Draft — edit it before you send
        </label>
        <textarea
          id={`draft-${card.taskId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className={cn(
            'w-full rounded-lg border px-3 py-2 text-sm leading-relaxed outline-none transition',
            over ? 'border-red-300 focus:border-red-500' : 'border-ink-200 focus:border-brand-500'
          )}
        />
        <p className={cn('mt-1 text-xs', over ? 'text-red-700 font-medium' : 'text-ink-400')}>
          {text.trim().length} / {card.limit} characters
          {over && ' — LinkedIn would truncate this mid-sentence'}
        </p>

        {card.usedHooks.length > 0 && (
          <p className="mt-1 text-xs text-ink-400">
            Grounded in: {card.usedHooks.join(', ')}
          </p>
        )}

        {card.checks.length > 0 && (
          <ul className="mt-3 space-y-1">
            {card.checks.map((c, i) => (
              <li
                key={i}
                className={cn(
                  'text-xs flex items-start gap-1.5',
                  c.severity === 'error' ? 'text-red-700'
                    : c.severity === 'warning' ? 'text-amber-800'
                    : 'text-ink-500'
                )}
              >
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                {c.message}
              </li>
            ))}
          </ul>
        )}

        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={copyAndOpen}
            disabled={pending || blocking}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {/* Without a URL there is no profile to open, and a button that says
                it will open one and then does nothing is worse than a plain copy. */}
            {copied ? 'Copied' : card.profileUrl ? 'Copy & open profile' : 'Copy note'}
          </button>

          <button
            onClick={() => act('sent')}
            disabled={pending || !canSend || blocking}
            title={canSend ? 'Record that you sent it' : 'Daily ceiling reached'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <Check className="h-4 w-4" />
            I sent it
          </button>

          <button
            onClick={() => act('already_connected')}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm hover:bg-ink-50 disabled:opacity-50 transition"
          >
            <UserCheck className="h-4 w-4 text-ink-500" />
            Already connected
          </button>

          <button
            onClick={() => act('not_a_fit')}
            disabled={pending}
            title="Marks them unqualified and stops any active sequence"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm hover:bg-ink-50 disabled:opacity-50 transition"
          >
            <Ban className="h-4 w-4 text-ink-500" />
            Not a fit
          </button>

          <button
            onClick={() => act('skipped')}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-ink-500 hover:bg-ink-100 disabled:opacity-50 transition"
          >
            <SkipForward className="h-4 w-4" />
            Skip
          </button>
        </div>

        <p className="mt-2 text-xs text-ink-400">
          “I sent it” is your word, not something the app observed — it cannot see LinkedIn. It is
          recorded that way on the timeline.
        </p>
      </div>
    </li>
  )
}

export function BuildListButton() {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(20)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(null)
    setMessage(null)
    startTransition(async () => {
      const r = await buildTargetList(size)
      if (!r.ok) setError(r.error)
      else {
        setMessage(
          r.data?.queued
            ? `Queued ${r.data.queued} cards.`
            : 'Nothing new to queue — everyone eligible is already in the queue.'
        )
        setOpen(false)
      }
    })
  }

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
        >
          <ListPlus className="h-4 w-4" />
          Build target list
        </button>
        {message && <p className="text-xs text-emerald-700">{message}</p>}
        {error && <p className="text-xs text-red-700 max-w-xs text-right">{error}</p>}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 w-72 shadow-sm">
      <p className="text-sm font-semibold text-ink-900 mb-1">Build a target list</p>
      <p className="text-xs text-ink-500 mb-3">
        Takes your highest-scoring contacts that have a profile URL.
      </p>
      <label className="block mb-3">
        <span className="block text-xs text-ink-600 mb-1">How many</span>
        <input
          type="number"
          min={1}
          max={50}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm outline-none"
        />
      </label>
      {error && <p className="text-xs text-red-700 mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={pending}
          className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
        >
          {pending ? 'Building…' : 'Build'}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 transition"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// Shared with the server importer. This used to be a hand-copied duplicate, and
// it had drifted: the server understood `companyDomain` and `country`, the wizard
// offered neither, so those columns were silently dropped from every file.
const SN_FIELDS = SALESNAV_FIELDS
const SN_ALIASES: Record<string, string> = SALESNAV_ALIASES

export function SalesNavImport() {
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState<Awaited<ReturnType<typeof runSalesNavImport>> | null>(null)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const hs = res.meta.fields ?? []
        const data = res.data.filter((r) => Object.values(r).some((v) => v?.trim()))
        const auto: Record<string, string> = {}
        for (const h of hs) {
          const f = SN_ALIASES[h.trim().toLowerCase()]
          if (f && !auto[f]) auto[f] = h
        }
        setHeaders(hs)
        setRows(data)
        setMapping(auto)
        setFileName(file.name)
        setResult(null)
      },
    })
  }

  function run(dryRun: boolean) {
    startTransition(async () => {
      setResult(await runSalesNavImport({ rows, mapping, dryRun, assignToMe: true }))
    })
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-ink-200">
        <h2 className="text-sm font-semibold text-ink-900">Sales Navigator import</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          An export LinkedIn gives you. Keyed on profile URL, because these files usually have no
          email — the generic CSV importer would reject every row.
        </p>
      </div>

      <div className="p-5">
        {rows.length === 0 ? (
          <>
            <button
              onClick={() => inputRef.current?.click()}
              className="w-full rounded-lg border-2 border-dashed border-ink-200 py-6 text-center hover:border-brand-400 transition"
            >
              <FileSpreadsheet className="h-5 w-5 text-ink-400 mx-auto mb-1.5" />
              <span className="text-sm text-ink-700">Choose a CSV</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
            />
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 mb-3">
              <p className="text-xs text-ink-600 truncate">
                {fileName} · {formatNumber(rows.length)} rows
              </p>
              <button
                onClick={() => { setRows([]); setResult(null) }}
                className="text-xs text-ink-500 hover:text-ink-900 shrink-0"
              >
                Change
              </button>
            </div>

            <div className="space-y-2 mb-4">
              {SN_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <label htmlFor={`sn-${f.key}`} className="w-24 shrink-0 text-xs text-ink-600">
                    {f.label}
                    {f.required && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    id={`sn-${f.key}`}
                    value={mapping[f.key] ?? ''}
                    onChange={(e) =>
                      setMapping((m) => {
                        const next = { ...m }
                        if (e.target.value) next[f.key] = e.target.value
                        else delete next[f.key]
                        return next
                      })
                    }
                    className={cn(
                      'flex-1 min-w-0 rounded-lg border px-2 py-1 text-xs outline-none',
                      f.required && !mapping[f.key] ? 'border-red-300' : 'border-ink-200'
                    )}
                  >
                    <option value="">— none —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {result && !result.ok && (
              <p role="alert" className="mb-3 text-xs text-red-700">{result.error}</p>
            )}
            {result?.ok && result.data && (
              <div className="mb-3 rounded-lg border border-ink-200 p-3 text-xs space-y-1">
                {result.data.dryRun && <Badge tone="brand">Dry run — nothing written</Badge>}
                <p className="text-ink-700">
                  {formatNumber(result.data.created)} to create ·{' '}
                  {formatNumber(result.data.updated)} already known ·{' '}
                  {formatNumber(result.data.skipped)} unusable
                </p>
                <p className="text-ink-500">
                  {formatNumber(result.data.withoutEmail)} have no email address — normal for these
                  exports, and they can still be worked on LinkedIn.
                </p>
                {result.data.errors.length > 0 && (
                  <p className="text-amber-800">
                    {result.data.errors.length} row
                    {result.data.errors.length === 1 ? '' : 's'} need attention (first:{' '}
                    {result.data.errors[0].reason})
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => run(true)}
                disabled={pending || !mapping.linkedinUrl}
                className="flex-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
              >
                {pending ? 'Checking…' : 'Validate'}
              </button>
              <button
                onClick={() => run(false)}
                disabled={pending || !mapping.linkedinUrl}
                className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
