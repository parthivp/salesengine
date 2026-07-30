'use client'

import { useState, useTransition } from 'react'
import { Play, Pause, Users, AlertTriangle } from 'lucide-react'
import type { SequenceStatus } from '@prisma/client'
import { setSequenceStatus, enrolContacts } from '../actions'
import { cn } from '@/lib/utils'

export function SequenceControls({
  sequenceId,
  status,
  stepCount,
  mailboxCount,
}: {
  sequenceId: string
  status: SequenceStatus
  stepCount: number
  mailboxCount: number
}) {
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function change(next: 'active' | 'paused' | 'draft') {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const r = await setSequenceStatus(sequenceId, next)
      if (!r.ok) setError(r.error)
    })
  }

  function enrol() {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const r = await enrolContacts(sequenceId, {})
      if (!r.ok) setError(r.error)
      else setNotice(`Queued ${r.data?.queued ?? 0} contacts for enrollment.`)
    })
  }

  const canActivate = stepCount > 0 && mailboxCount > 0

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          onClick={enrol}
          disabled={pending || status !== 'active'}
          title={status !== 'active' ? 'Activate the sequence first' : 'Enrol eligible contacts'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium hover:bg-ink-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <Users className="h-4 w-4" />
          Enrol contacts
        </button>

        {status === 'active' ? (
          <button
            onClick={() => change('paused')}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 transition"
          >
            <Pause className="h-4 w-4" />
            Pause
          </button>
        ) : (
          <button
            onClick={() => change('active')}
            disabled={pending || !canActivate}
            title={!canActivate ? 'Needs at least one step and a connected mailbox' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition',
              canActivate
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'bg-ink-100 text-ink-400 cursor-not-allowed'
            )}
          >
            <Play className="h-4 w-4" />
            {pending ? 'Activating…' : 'Activate'}
          </button>
        )}
      </div>

      {!canActivate && status !== 'active' && (
        <p className="text-xs text-amber-700 inline-flex items-center gap-1 max-w-xs text-right">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {stepCount === 0
            ? 'Add a step before activating.'
            : 'Connect a sending mailbox in Admin → Mailboxes before activating.'}
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-700 max-w-xs text-right">
          {error}
        </p>
      )}
      {notice && <p className="text-xs text-emerald-700 max-w-xs text-right">{notice}</p>}
    </div>
  )
}
