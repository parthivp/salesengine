'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui'
import { cn, formatCurrency, formatRelative } from '@/lib/utils'
import { Plus, AlertTriangle, ChevronRight, ChevronLeft } from 'lucide-react'
import { move, createDeal } from './actions'

type Stage = { id: string; name: string; probability: number; isWon: boolean; isLost: boolean }

type DealCard = {
  id: string
  name: string
  value: number
  currency: string
  stageId: string
  owner: string | null
  accountName: string | null
  contactId: string | null
  contactName: string | null
  expectedCloseDate: string | null
  health: { status: string; reason: string | null; days: number | null }
}

export function Board({ stages, deals }: { stages: Stage[]; deals: DealCard[] }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function moveTo(dealId: string, stageId: string) {
    setError(null)
    startTransition(async () => {
      const r = await move(dealId, stageId)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className={cn('flex gap-4 overflow-x-auto pb-4', pending && 'opacity-70')}>
        {stages.map((stage, i) => {
          const inStage = deals.filter((d) => d.stageId === stage.id)
          const total = inStage.reduce((n, d) => n + d.value, 0)
          const prev = stages[i - 1]
          const next = stages[i + 1]

          return (
            <section
              key={stage.id}
              className="w-72 shrink-0 rounded-xl border border-ink-200 bg-white flex flex-col"
              aria-label={stage.name}
            >
              <header className="px-3 py-2.5 border-b border-ink-200">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-ink-900 truncate">{stage.name}</h2>
                  <Badge
                    tone={stage.isWon ? 'success' : stage.isLost ? 'neutral' : 'brand'}
                  >
                    {inStage.length}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-ink-500 tabular-nums">
                  {formatCurrency(total)}
                  {!stage.isWon && !stage.isLost && ` · ${stage.probability}%`}
                </p>
              </header>

              <ul className="p-2 space-y-2 flex-1 min-h-24">
                {inStage.length === 0 ? (
                  <li className="text-xs text-ink-400 px-1 py-3 text-center">Empty</li>
                ) : (
                  inStage.map((d) => (
                    <li
                      key={d.id}
                      className={cn(
                        'rounded-lg border p-2.5 bg-white',
                        d.health.status === 'rotting'
                          ? 'border-red-200 bg-red-50/40'
                          : d.health.status === 'watch'
                            ? 'border-amber-200 bg-amber-50/30'
                            : 'border-ink-200'
                      )}
                    >
                      <p className="text-sm font-medium text-ink-900 truncate">{d.name}</p>
                      <p className="text-sm tabular-nums text-ink-800">
                        {formatCurrency(d.value, d.currency)}
                      </p>

                      <p className="mt-0.5 text-xs text-ink-500 truncate">
                        {d.accountName ?? '—'}
                        {d.contactId && d.contactName && (
                          <>
                            {' · '}
                            <Link href={`/contacts/${d.contactId}`} className="hover:text-brand-700">
                              {d.contactName}
                            </Link>
                          </>
                        )}
                      </p>

                      {d.expectedCloseDate && (
                        <p className="text-xs text-ink-400">
                          close {formatRelative(d.expectedCloseDate)}
                        </p>
                      )}

                      {d.health.status === 'rotting' && d.health.reason && (
                        <p className="mt-1.5 text-xs text-red-700 flex items-start gap-1">
                          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                          {d.health.reason}
                        </p>
                      )}

                      <div className="mt-2 flex items-center justify-between gap-1">
                        <button
                          onClick={() => prev && moveTo(d.id, prev.id)}
                          disabled={!prev || pending}
                          title={prev ? `Move back to ${prev.name}` : 'No earlier stage'}
                          aria-label={prev ? `Move ${d.name} back to ${prev.name}` : 'No earlier stage'}
                          className="rounded p-1 hover:bg-ink-100 disabled:opacity-30 transition"
                        >
                          <ChevronLeft className="h-3.5 w-3.5 text-ink-500" />
                        </button>

                        <select
                          value={d.stageId}
                          onChange={(e) => moveTo(d.id, e.target.value)}
                          disabled={pending}
                          aria-label={`Stage for ${d.name}`}
                          className="flex-1 min-w-0 rounded border border-ink-200 px-1.5 py-0.5 text-xs outline-none focus:border-brand-500"
                        >
                          {stages.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>

                        <button
                          onClick={() => next && moveTo(d.id, next.id)}
                          disabled={!next || pending}
                          title={next ? `Advance to ${next.name}` : 'No later stage'}
                          aria-label={next ? `Advance ${d.name} to ${next.name}` : 'No later stage'}
                          className="rounded p-1 hover:bg-ink-100 disabled:opacity-30 transition"
                        >
                          <ChevronRight className="h-3.5 w-3.5 text-ink-500" />
                        </button>
                      </div>

                      {d.owner && <p className="mt-1 text-xs text-ink-400 truncate">{d.owner}</p>}
                    </li>
                  ))
                )}
              </ul>
            </section>
          )
        })}
      </div>

      <p className="mt-2 text-xs text-ink-500">
        Arrows and the dropdown both move a deal — chosen over drag-and-drop so the board works with a
        keyboard and on a phone. Winning a deal marks the contact a customer and clears its open tasks.
      </p>
    </>
  )
}

export function NewDealButton() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState(10000)
  const [closeInDays, setCloseInDays] = useState(30)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(null)
    startTransition(async () => {
      const r = await createDeal({ name, value, closeInDays })
      if (!r.ok) setError(r.error)
      else {
        setOpen(false)
        setName('')
      }
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
      >
        <Plus className="h-4 w-4" />
        New deal
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 w-72 shadow-sm">
      <p className="text-sm font-semibold text-ink-900 mb-3">New deal</p>
      <div className="space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Northwind — Q4 rollout"
          aria-label="Deal name"
          className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-xs text-ink-500 mb-1">Value</span>
            <input
              type="number"
              min={0}
              step={1000}
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500 mb-1">Close in (days)</span>
            <input
              type="number"
              min={1}
              max={730}
              value={closeInDays}
              onChange={(e) => setCloseInDays(Number(e.target.value))}
              className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm outline-none"
            />
          </label>
        </div>
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={pending || name.trim().length < 2}
            className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
