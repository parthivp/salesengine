'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useTransition, useState, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const STATUSES = [
  'new', 'working', 'engaged', 'qualified', 'unqualified', 'customer', 'do_not_contact',
] as const

export function ContactFilters({ counts }: { counts: Record<string, number> }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [q, setQ] = useState(params.get('q') ?? '')
  const activeStatus = params.get('status')
  const mineOnly = params.get('owner') === 'me'

  // Debounced search: typing should not fire a query per keystroke.
  useEffect(() => {
    const current = params.get('q') ?? ''
    if (q === current) return
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (q) next.set('q', q)
      else next.delete('q')
      next.delete('page')
      startTransition(() => router.replace(`${pathname}?${next}`))
    }, 350)
    return () => clearTimeout(t)
  }, [q, params, pathname, router])

  function toggle(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (next.get(key) === value) next.delete(key)
    else next.set(key, value)
    next.delete('page')
    startTransition(() => router.replace(`${pathname}?${next}`))
  }

  const hasFilters = Boolean(activeStatus || mineOnly || q)

  return (
    <div className={cn('mb-4 space-y-3', pending && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-56 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, title or company"
            aria-label="Search contacts"
            className="w-full rounded-lg border border-ink-200 bg-white pl-8 pr-8 py-2 text-sm placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
          />
          {q && (
            <button
              onClick={() => setQ('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <button
          onClick={() => toggle('owner', 'me')}
          className={cn(
            'rounded-lg border px-3 py-2 text-sm font-medium transition',
            mineOnly
              ? 'border-brand-500 bg-brand-50 text-brand-700'
              : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50'
          )}
        >
          My contacts
        </button>

        {hasFilters && (
          <button
            onClick={() => startTransition(() => router.replace(pathname))}
            className="text-sm text-ink-500 hover:text-ink-900 px-2 py-2"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => {
          const count = counts[s] ?? 0
          const active = activeStatus === s
          return (
            <button
              key={s}
              onClick={() => toggle('status', s)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition',
                active
                  ? 'bg-brand-600 text-white'
                  : count === 0
                    ? 'bg-ink-50 text-ink-400 hover:bg-ink-100'
                    : 'bg-white border border-ink-200 text-ink-600 hover:bg-ink-50'
              )}
            >
              {s.replace(/_/g, ' ')}
              <span className={cn('ml-1.5 tabular-nums', active ? 'text-brand-100' : 'text-ink-400')}>
                {count}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
