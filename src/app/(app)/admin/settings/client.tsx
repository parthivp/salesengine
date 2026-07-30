'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui'
import { Check, AlertTriangle } from 'lucide-react'
import { saveSettings } from './actions'

const TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
  'Europe/London', 'Europe/Berlin', 'Europe/Lisbon',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Australia/Sydney', 'UTC',
]

export function SettingsForm({
  name: initialName,
  timezone: initialTimezone,
  windowStart,
  windowEnd,
}: {
  name: string
  timezone: string
  windowStart: number
  windowEnd: number
}) {
  const [name, setName] = useState(initialName)
  const [timezone, setTimezone] = useState(initialTimezone)
  const [start, setStart] = useState(String(windowStart))
  const [end, setEnd] = useState(String(windowEnd))
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const badWindow = Number(end) <= Number(start)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(null)
    startTransition(async () => {
      const r = await saveSettings({
        name,
        timezone,
        defaultSendWindowStart: Number(start),
        defaultSendWindowEnd: Number(end),
      })
      if (!r.ok) setError(r.error)
      else setSaved(r.message)
    })
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Workspace</h2>
      <p className="mt-0.5 text-xs text-ink-500 mb-4">
        The timezone is the fallback for send windows when a contact&rsquo;s own timezone is unknown.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Workspace name</span>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setSaved(null) }}
            required
            maxLength={120}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 outline-none transition"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Default timezone</span>
          <select
            value={timezone}
            onChange={(e) => { setTimezone(e.target.value); setSaved(null) }}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 outline-none transition"
          >
            {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </label>

        <div>
          <span className="block text-xs font-medium text-ink-600 mb-1">
            Default sending window for new sequences
          </span>
          <div className="flex items-center gap-2">
            <select
              value={start}
              onChange={(e) => { setStart(e.target.value); setSaved(null) }}
              className="rounded-lg border border-ink-200 px-2.5 py-2 text-sm focus:border-brand-500 outline-none"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
            <span className="text-sm text-ink-500">to</span>
            <select
              value={end}
              onChange={(e) => { setEnd(e.target.value); setSaved(null) }}
              className="rounded-lg border border-ink-200 px-2.5 py-2 text-sm focus:border-brand-500 outline-none"
            >
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>
          {badWindow && (
            <p className="mt-1 text-xs text-red-700">The window has to end after it starts.</p>
          )}
          <p className="mt-1 text-xs text-ink-400">
            Applies to sequences created from now on. Existing sequences keep their own window —
            changing a default must not silently retime a campaign already in flight.
          </p>
        </div>

        {saved && (
          <p className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
            <Check className="h-3.5 w-3.5" />
            {saved}
          </p>
        )}
        {error && (
          <p role="alert" className="inline-flex items-center gap-1.5 text-xs text-red-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || badWindow || !name.trim()}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {pending ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </Card>
  )
}
