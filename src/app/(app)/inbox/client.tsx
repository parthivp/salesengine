'use client'

import { useState, useTransition, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui'
import { cn, formatNumber } from '@/lib/utils'
import {
  Check, AlertTriangle, ExternalLink, Search, Inbox as InboxIcon,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import { reclassify, markHandled } from './actions'
import { DeleteButton } from '../delete-button'
import { INTENT_LABEL, INTENT_TONE, type ReplyIntent } from '@/lib/email/classify'

/**
 * The inbox, as a mail client rather than a feed.
 *
 * The old layout gave each message a card with its body, its classification, its
 * reasoning and eight correction buttons — perhaps four messages on a screen. That
 * is the right shape for triaging three replies and the wrong shape for a mailbox,
 * which is what this became once it started receiving everything the address
 * receives. Anyone who has used mail software knows the answer: a dense list on one
 * side, one message open on the other. Scanning and reading are different jobs and
 * the list should be optimised for the first.
 *
 * Everything that was on a card is still here — it moved to the reading pane, where
 * it applies to the one message you are actually looking at.
 */

export type Folder = 'replies' | 'review' | 'other'

export type MailRow = {
  id: string
  subject: string
  bodyText: string
  fromEmail: string
  receivedAt: string
  intent: ReplyIntent | null
  confidence: number | null
  reasons: string[]
  needsReview: boolean
  filtered: boolean
  contact: { id: string; name: string; title: string | null; company: string | null } | null
  sequenceName: string | null
}

const INTENTS: ReplyIntent[] = [
  'interested', 'not_interested', 'wrong_person', 'unsubscribe',
  'out_of_office', 'auto_reply', 'bounce', 'unclear',
]

const TABS: { key: Folder; label: string }[] = [
  { key: 'replies', label: 'Replies' },
  { key: 'review', label: 'Needs a read' },
  { key: 'other', label: 'Other mail' },
]

export function MailView({
  rows,
  folder,
  page,
  pageSize,
  total,
  counts,
  canDelete,
  lastPoll,
}: {
  rows: MailRow[]
  folder: Folder
  page: number
  pageSize: number
  total: number
  counts: { replies: number; review: number; other: number }
  canDelete: boolean
  lastPoll: string | null
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // "Needs a read" filters the replies already loaded rather than being its own
  // query — see the note in page.tsx about where that judgement is stored.
  const visible = useMemo(() => {
    const base = folder === 'review' ? rows.filter((r) => r.needsReview) : rows
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((r) =>
      [r.subject, r.fromEmail, r.bodyText, r.contact?.name, r.contact?.company]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q))
    )
  }, [rows, folder, query])

  const [openId, setOpenId] = useState<string | null>(null)
  const open = visible.find((r) => r.id === openId) ?? visible[0] ?? null

  const allShown = visible.length > 0 && visible.every((r) => selected.has(r.id))
  const lastPage = Math.max(1, Math.ceil(total / pageSize))

  function go(next: Partial<{ folder: Folder; page: number }>) {
    const params = new URLSearchParams()
    params.set('folder', next.folder ?? folder)
    const p = next.page ?? (next.folder ? 1 : page)
    if (p > 1) params.set('page', String(p))
    setSelected(new Set())
    router.push(`/inbox?${params.toString()}`)
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => go({ folder: t.key })}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-sm transition',
                folder === t.key
                  ? 'bg-brand-50 text-brand-800 font-medium'
                  : 'text-ink-600 hover:bg-ink-50'
              )}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-ink-400 tabular-nums">
                {formatNumber(counts[t.key])}
              </span>
            </button>
          ))}
        </div>

        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this page"
            aria-label="Search the messages on this page"
            className="w-56 rounded-lg border border-ink-200 py-1.5 pl-8 pr-2 text-sm placeholder:text-ink-400 focus:border-brand-400 focus:outline-none"
          />
        </div>

        {canDelete && selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-600">{formatNumber(selected.size)} selected</span>
            <button onClick={() => setSelected(new Set())} className="text-xs text-ink-500 hover:text-ink-900">
              Clear
            </button>
            <DeleteButton kind="message" ids={[...selected]} variant="button" label="Delete" />
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="px-5 py-16 text-center">
          <InboxIcon className="mx-auto h-6 w-6 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-800">
            {query
              ? 'Nothing on this page matches that.'
              : folder === 'other'
                ? 'No newsletters or notifications yet.'
                : folder === 'review'
                  ? 'Nothing ambiguous — every reply on this page was read confidently.'
                  : 'No replies yet.'}
          </p>
          <p className="mt-1 text-sm text-ink-500">
            {folder === 'replies' && !query
              ? 'Replies are pulled from your mailboxes every few minutes and read for intent.'
              : 'Try another folder.'}
          </p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] divide-x divide-ink-100">
          {/* --- list ------------------------------------------------------- */}
          <div className="max-h-[calc(100vh-19rem)] min-h-[28rem] overflow-y-auto">
            {canDelete && (
              <label className="flex items-center gap-2 border-b border-ink-100 px-3 py-1.5 text-xs text-ink-500">
                <input
                  type="checkbox"
                  checked={allShown}
                  onChange={() =>
                    setSelected(allShown ? new Set() : new Set(visible.map((r) => r.id)))
                  }
                  aria-label="Select every message shown"
                  className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                />
                Select all {formatNumber(visible.length)}
              </label>
            )}

            <ul className="divide-y divide-ink-100">
              {visible.map((r) => (
                <li key={r.id}>
                  <div
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left transition',
                      open?.id === r.id ? 'bg-brand-50/70' : 'hover:bg-ink-50/70',
                      selected.has(r.id) && 'bg-brand-50/40'
                    )}
                  >
                    {canDelete && (
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        aria-label={`Select ${r.subject || 'message'}`}
                        className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-ink-300 accent-brand-600"
                      />
                    )}
                    <button onClick={() => setOpenId(r.id)} className="min-w-0 flex-1 text-left">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-ink-900">
                          {r.contact?.name ?? r.fromEmail}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-400">{r.receivedAt}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[13px] text-ink-700">
                        {r.subject || '(no subject)'}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-400">
                        {r.bodyText.slice(0, 120) || '(no text body)'}
                      </span>
                      {(r.intent || r.needsReview || !r.contact) && (
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          {r.intent && <Badge tone={INTENT_TONE[r.intent]}>{INTENT_LABEL[r.intent]}</Badge>}
                          {r.needsReview && r.intent !== 'unclear' && <Badge tone="warning">needs a read</Badge>}
                          {!r.contact && !r.filtered && <Badge tone="neutral">unmatched</Badge>}
                        </span>
                      )}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* --- reading pane ----------------------------------------------- */}
          <div className="max-h-[calc(100vh-19rem)] min-h-[28rem] overflow-y-auto">
            {open ? <Reading key={open.id} row={open} canDelete={canDelete} /> : null}
          </div>
        </div>
      )}

      {/* Footer: what you are looking at, out of what. The old page took the most
          recent 100 and said so in a hint nobody reads, so "how many are there?"
          had no answer anywhere on screen. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 px-3 py-2 text-xs text-ink-500">
        <span>
          {total === 0
            ? 'Nothing here'
            : `Showing ${formatNumber((page - 1) * pageSize + 1)}–${formatNumber(
                Math.min(page * pageSize, total)
              )} of ${formatNumber(total)}`}
          {query && ` · ${formatNumber(visible.length)} match “${query}”`}
          {lastPoll && ` · mailbox last checked ${lastPoll}`}
        </span>
        {lastPage > 1 && (
          <span className="flex items-center gap-1">
            <button
              onClick={() => go({ page: page - 1 })}
              disabled={page <= 1}
              className="inline-flex items-center gap-0.5 rounded-md border border-ink-200 px-2 py-1 disabled:opacity-40 hover:bg-ink-50 transition"
            >
              <ChevronLeft className="h-3 w-3" /> Newer
            </button>
            <span className="px-1 tabular-nums">
              {page} / {lastPage}
            </span>
            <button
              onClick={() => go({ page: page + 1 })}
              disabled={page >= lastPage}
              className="inline-flex items-center gap-0.5 rounded-md border border-ink-200 px-2 py-1 disabled:opacity-40 hover:bg-ink-50 transition"
            >
              Older <ChevronRight className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Reading({ row, canDelete }: { row: MailRow; canDelete: boolean }) {
  const [intent, setIntent] = useState<ReplyIntent | null>(row.intent)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function choose(next: ReplyIntent) {
    setError(null)
    startTransition(async () => {
      const r = await reclassify({ messageId: row.id, intent: next })
      if (!r.ok) setError(r.error)
      else {
        setIntent(next)
        setDone(r.actions.join(', ') || 'updated')
      }
    })
  }

  function handled() {
    setError(null)
    startTransition(async () => {
      const r = await markHandled(row.id)
      if (!r.ok) setError(r.error)
      else setDone(r.actions.join(', '))
    })
  }

  return (
    <div className={cn('p-5', pending && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-900">{row.subject || '(no subject)'}</h2>
          <p className="mt-1 text-sm text-ink-600">
            {row.contact ? (
              <Link href={`/contacts/${row.contact.id}`} className="font-medium hover:text-brand-700">
                {row.contact.name}
              </Link>
            ) : (
              <span className="font-medium">{row.fromEmail}</span>
            )}
            {row.contact && <span className="text-ink-400"> · {row.fromEmail}</span>}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {[
              row.contact?.title,
              row.contact?.company,
              row.sequenceName && `from “${row.sequenceName}”`,
              row.receivedAt,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.contact && (
            <Link
              href={`/contacts/${row.contact.id}`}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs text-ink-600 hover:text-brand-700 transition"
            >
              <ExternalLink className="h-3 w-3" />
              Record
            </Link>
          )}
          {canDelete && <DeleteButton kind="message" ids={[row.id]} />}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {intent && <Badge tone={INTENT_TONE[intent]}>{INTENT_LABEL[intent]}</Badge>}
        {row.needsReview && intent !== 'unclear' && <Badge tone="warning">needs a read</Badge>}
        {row.filtered && <Badge tone="neutral">not a reply</Badge>}
        {!row.contact && !row.filtered && <Badge tone="neutral">unmatched</Badge>}
      </div>

      <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ink-800">
        {row.bodyText || '(no text body)'}
      </p>

      {/* Why the machine decided what it did. The classifier is heuristic, so the
          person overruling it needs to see its reasoning, not just its verdict. */}
      {row.reasons.length > 0 && (
        <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-400">
          Read as {intent ? INTENT_LABEL[intent].toLowerCase() : 'unclassified'}
          {row.confidence != null && ` (${Math.round(row.confidence * 100)}% confident)`}
          {' — '}
          {row.reasons.join('; ')}
        </p>
      )}

      {done && (
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-700">
          <Check className="h-3.5 w-3.5" />
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 inline-flex items-center gap-1.5 text-xs text-red-700">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}

      {row.contact && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-ink-100 pt-3">
          <span className="mr-1 text-xs text-ink-400">It is actually:</span>
          {INTENTS.filter((i) => i !== intent).map((i) => (
            <button
              key={i}
              onClick={() => choose(i)}
              disabled={pending}
              className="rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50 disabled:opacity-50 transition"
            >
              {INTENT_LABEL[i]}
            </button>
          ))}
          <button
            onClick={handled}
            disabled={pending}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 transition"
          >
            Handled
          </button>
        </div>
      )}
    </div>
  )
}
