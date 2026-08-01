'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui'
import { formatNumber } from '@/lib/utils'
import { DeleteButton } from '../delete-button'

/**
 * The contacts table, with selection.
 *
 * A client component only because selection is client state. Everything it
 * renders is decided on the server and passed in — the scores, the bands, the
 * relative dates — so this file holds no business rules and cannot disagree with
 * the page about what a contact is.
 *
 * Selection exists for one reason: the first thing anybody does after a test
 * import is want to remove all of it, and doing that one row at a time is the
 * kind of small cruelty that makes people stop trusting a tool.
 */

export type Row = {
  id: string
  name: string
  sub: string
  accountId: string | null
  accountName: string | null
  status: string
  statusTone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
  score: number
  bandLabel: string
  bandTone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
  owner: string
  added: string
}

export function ContactsTable({ rows, canDelete }: { rows: Row[]; canDelete: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => (allOnPage ? new Set() : new Set([...prev, ...rows.map((r) => r.id)])))
  }

  return (
    <>
      {selected.size > 0 && (
        // Sticky, because a selection made at the bottom of a long list would
        // otherwise put the action off screen.
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-ink-200 bg-brand-50/80 px-5 py-2.5 backdrop-blur">
          <p className="text-sm text-ink-700">
            {formatNumber(selected.size)} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-ink-500 hover:text-ink-900"
            >
              Clear
            </button>
            <DeleteButton kind="contact" ids={[...selected]} variant="button" label="Delete" />
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
              {canDelete && (
                <th className="w-10 px-5 py-2.5">
                  <input
                    type="checkbox"
                    checked={allOnPage}
                    onChange={toggleAll}
                    aria-label="Select every contact on this page"
                    className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                  />
                </th>
              )}
              <th className="px-5 py-2.5 font-medium">Contact</th>
              <th className="px-5 py-2.5 font-medium">Company</th>
              <th className="px-5 py-2.5 font-medium">Status</th>
              <th className="px-5 py-2.5 font-medium">Score</th>
              <th className="px-5 py-2.5 font-medium">Owner</th>
              <th className="px-5 py-2.5 font-medium">Added</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? 'bg-brand-50/50' : 'hover:bg-ink-50/60'}>
                {canDelete && (
                  <td className="px-5 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select ${r.name}`}
                      className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                    />
                  </td>
                )}
                <td className="px-5 py-3">
                  <Link href={`/contacts/${r.id}`} className="group block">
                    <p className="font-medium text-ink-900 group-hover:text-brand-700 truncate">
                      {r.name}
                    </p>
                    <p className="text-xs text-ink-500 truncate">{r.sub}</p>
                  </Link>
                </td>
                <td className="px-5 py-3">
                  {r.accountId ? (
                    <Link href={`/accounts/${r.accountId}`} className="text-ink-700 hover:text-brand-700">
                      {r.accountName}
                    </Link>
                  ) : (
                    <span className="text-ink-400">—</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <Badge tone={r.statusTone}>{r.status}</Badge>
                </td>
                <td className="px-5 py-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="tabular-nums font-medium text-ink-900">{r.score}</span>
                    <Badge tone={r.bandTone}>{r.bandLabel}</Badge>
                  </span>
                </td>
                <td className="px-5 py-3 text-ink-600">{r.owner}</td>
                <td className="px-5 py-3 text-ink-500">{r.added}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
