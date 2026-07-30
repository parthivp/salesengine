'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { createSequence } from './actions'

export function NewSequenceButton() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const r = await createSequence({ name, description: description || undefined })
      if (!r.ok) {
        setError(r.error)
        return
      }
      setOpen(false)
      setName('')
      setDescription('')
      if (r.data?.id) router.push(`/sequences/${r.data.id}`)
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
      >
        <Plus className="h-4 w-4" />
        New sequence
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 w-80 shadow-sm">
      <p className="text-sm font-semibold text-ink-900 mb-3">New sequence</p>
      <div className="space-y-3">
        <div>
          <label htmlFor="seq-name" className="block text-xs font-medium text-ink-600 mb-1">
            Name
          </label>
          <input
            id="seq-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="Q3 logistics outbound"
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>
        <div>
          <label htmlFor="seq-desc" className="block text-xs font-medium text-ink-600 mb-1">
            Description <span className="text-ink-400">(optional)</span>
          </label>
          <input
            id="seq-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={pending || name.trim().length < 2}
            className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
          <button
            onClick={() => { setOpen(false); setError(null) }}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
