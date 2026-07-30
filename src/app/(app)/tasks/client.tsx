'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Card, Badge } from '@/components/ui'
import { cn, formatRelative } from '@/lib/utils'
import {
  Phone, Mail, Linkedin, CalendarClock, CornerUpRight, CircleDot,
  Check, Clock, SkipForward, Plus, Copy,
} from 'lucide-react'
import { complete, snooze, skip, createTask } from './actions'

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  email: Mail,
  linkedin: Linkedin,
  meeting: CalendarClock,
  follow_up: CornerUpRight,
  other: CircleDot,
}

const OUTCOMES: Record<string, string[]> = {
  call: ['Connected', 'Voicemail', 'No answer', 'Meeting booked', 'Not interested'],
  email: ['Sent', 'Replied', 'Bounced'],
  linkedin: ['Sent', 'Accepted', 'Declined', 'No response'],
  follow_up: ['Done', 'Meeting booked', 'Deferred', 'Not interested'],
  meeting: ['Held', 'No-show', 'Rescheduled', 'Cancelled'],
  other: ['Done', 'Skipped'],
}

const BUCKET_META: Record<string, { label: string; tone: string }> = {
  overdue: { label: 'Overdue', tone: 'text-red-700' },
  today: { label: 'Due today', tone: 'text-ink-900' },
  upcoming: { label: 'Upcoming', tone: 'text-ink-700' },
  snoozed: { label: 'Snoozed', tone: 'text-ink-500' },
}

export type TaskRow = {
  id: string
  type: string
  title: string
  note: string | null
  priority: number
  dueAt: string | null
  snoozedTo: string | null
  bucket: string
  assignee: string | null
  payload: Record<string, unknown>
  contact: { id: string; name: string; title: string | null; company: string | null } | null
}

export function TaskQueue({
  bucket,
  tasks,
  showAssignee,
}: {
  bucket: string
  tasks: TaskRow[]
  showAssignee: boolean
}) {
  const meta = BUCKET_META[bucket] ?? { label: bucket, tone: 'text-ink-700' }

  return (
    <Card>
      <div className="px-5 py-3 border-b border-ink-200 flex items-center justify-between">
        <h2 className={cn('text-sm font-semibold', meta.tone)}>{meta.label}</h2>
        <Badge tone={bucket === 'overdue' ? 'danger' : 'neutral'}>{tasks.length}</Badge>
      </div>
      <ul className="divide-y divide-ink-100">
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} showAssignee={showAssignee} />
        ))}
      </ul>
    </Card>
  )
}

function TaskItem({ task, showAssignee }: { task: TaskRow; showAssignee: boolean }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, startTransition] = useTransition()

  const Icon = TYPE_ICON[task.type] ?? CircleDot
  const outcomes = OUTCOMES[task.type] ?? OUTCOMES.other
  const draft = typeof task.payload.draft === 'string' ? task.payload.draft : null
  const linkedinUrl = typeof task.payload.linkedinUrl === 'string' ? task.payload.linkedinUrl : null

  function finish(outcome: string) {
    setError(null)
    startTransition(async () => {
      const r = await complete({ taskId: task.id, outcome, note: note || undefined })
      if (!r.ok) setError(r.error)
      else setDone(true)
    })
  }

  function doSnooze(days: number) {
    setError(null)
    startTransition(async () => {
      const r = await snooze(task.id, days)
      if (!r.ok) setError(r.error)
      else setDone(true)
    })
  }

  function doSkip() {
    setError(null)
    startTransition(async () => {
      const r = await skip(task.id, 'Skipped from queue')
      if (!r.ok) setError(r.error)
      else setDone(true)
    })
  }

  if (done) {
    return (
      <li className="px-5 py-3 flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50/40">
        <Check className="h-4 w-4" />
        {task.title} — handled
      </li>
    )
  }

  return (
    <li className={cn('px-5 py-3', pending && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <div className="h-7 w-7 rounded-lg bg-ink-100 grid place-items-center shrink-0 mt-0.5">
          <Icon className="h-3.5 w-3.5 text-ink-500" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-ink-900">{task.title}</p>
            {task.priority >= 3 && <Badge tone="danger">urgent</Badge>}
            {task.priority === 2 && <Badge tone="warning">high</Badge>}
            {showAssignee && task.assignee && <Badge>{task.assignee}</Badge>}
          </div>

          <p className="mt-0.5 text-xs text-ink-500">
            {task.contact && (
              <>
                <Link href={`/contacts/${task.contact.id}`} className="hover:text-brand-700">
                  {task.contact.name}
                </Link>
                {task.contact.company ? ` · ${task.contact.company}` : ''}
                {' · '}
              </>
            )}
            {task.bucket === 'snoozed'
              ? `snoozed until ${formatRelative(task.snoozedTo)}`
              : `due ${formatRelative(task.dueAt)}`}
          </p>

          {task.note && (
            <p className="mt-1.5 text-sm text-ink-600 whitespace-pre-line line-clamp-3">{task.note}</p>
          )}

          {draft && (
            <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-xs font-medium text-ink-700">Drafted message — you send it</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => navigator.clipboard?.writeText(draft)}
                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:text-brand-800"
                  >
                    <Copy className="h-3 w-3" />
                    Copy
                  </button>
                  {linkedinUrl && (
                    <a
                      href={linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-brand-700 hover:text-brand-800"
                    >
                      Open profile
                    </a>
                  )}
                </div>
              </div>
              <p className="text-sm text-ink-800 whitespace-pre-line">{draft}</p>
            </div>
          )}

          {open && (
            <div className="mt-3 space-y-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What happened? (optional, saved to the timeline)"
                className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
              />
              <div className="flex flex-wrap gap-1.5">
                {outcomes.map((o) => (
                  <button
                    key={o}
                    onClick={() => finish(o)}
                    disabled={pending}
                    className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition"
                  >
                    {o}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-400">
                Some outcomes do more than close the task — “Not interested” stops every active
                sequence for this contact, “Meeting booked” marks them qualified.
              </p>
            </div>
          )}

          {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
          >
            <Check className="h-3.5 w-3.5" />
            {open ? 'Cancel' : 'Complete'}
          </button>
          <button
            onClick={() => doSnooze(2)}
            disabled={pending}
            title="Snooze for 2 days"
            aria-label="Snooze for 2 days"
            className="rounded-lg border border-ink-200 p-1.5 hover:bg-ink-50 disabled:opacity-50 transition"
          >
            <Clock className="h-3.5 w-3.5 text-ink-500" />
          </button>
          <button
            onClick={doSkip}
            disabled={pending}
            title="Skip"
            aria-label="Skip this task"
            className="rounded-lg border border-ink-200 p-1.5 hover:bg-ink-50 disabled:opacity-50 transition"
          >
            <SkipForward className="h-3.5 w-3.5 text-ink-500" />
          </button>
        </div>
      </div>
    </li>
  )
}

export function NewTaskButton() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [type, setType] = useState('follow_up')
  const [inDays, setInDays] = useState(0)
  const [priority, setPriority] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(null)
    startTransition(async () => {
      const r = await createTask({ title, type: type as never, inDays, priority })
      if (!r.ok) setError(r.error)
      else {
        setOpen(false)
        setTitle('')
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
        Add task
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 w-80 shadow-sm">
      <p className="text-sm font-semibold text-ink-900 mb-3">New task</p>
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="Call Priya about pricing"
          aria-label="Task title"
          className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
        />
        <div className="grid grid-cols-3 gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Task type"
            className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm outline-none"
          >
            {['follow_up', 'call', 'email', 'linkedin', 'meeting', 'other'].map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <select
            value={inDays}
            onChange={(e) => setInDays(Number(e.target.value))}
            aria-label="Due in"
            className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm outline-none"
          >
            <option value={0}>Today</option>
            <option value={1}>Tomorrow</option>
            <option value={3}>In 3 days</option>
            <option value={7}>In a week</option>
          </select>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            aria-label="Priority"
            className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm outline-none"
          >
            <option value={0}>Low</option>
            <option value={1}>Normal</option>
            <option value={2}>High</option>
            <option value={3}>Urgent</option>
          </select>
        </div>
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={pending || title.trim().length < 2}
            className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
          >
            {pending ? 'Adding…' : 'Add'}
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
