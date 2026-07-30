'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Check, ChevronDown, AlertTriangle, ExternalLink } from 'lucide-react'
import { reclassify, markHandled } from './actions'
import { INTENT_LABEL, INTENT_TONE, type ReplyIntent } from '@/lib/email/classify'

export type ReplyRow = {
  id: string
  subject: string
  bodyText: string
  fromEmail: string
  receivedAt: string
  intent: ReplyIntent | null
  confidence: number | null
  reasons: string[]
  needsReview: boolean
  contact: { id: string; name: string; title: string | null; company: string | null } | null
  sequenceName: string | null
}

const INTENTS: ReplyIntent[] = [
  'interested', 'not_interested', 'wrong_person', 'unsubscribe',
  'out_of_office', 'auto_reply', 'bounce', 'unclear',
]

export function ReplyList({ replies }: { replies: ReplyRow[] }) {
  return (
    <ul className="divide-y divide-ink-100">
      {replies.map((r) => (
        <Reply key={r.id} reply={r} />
      ))}
    </ul>
  )
}

function Reply({ reply }: { reply: ReplyRow }) {
  const [expanded, setExpanded] = useState(false)
  const [intent, setIntent] = useState<ReplyIntent | null>(reply.intent)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function choose(next: ReplyIntent) {
    setError(null)
    startTransition(async () => {
      const r = await reclassify({ messageId: reply.id, intent: next })
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
      const r = await markHandled(reply.id)
      if (!r.ok) setError(r.error)
      else setDone(r.actions.join(', '))
    })
  }

  return (
    <li className={cn('px-5 py-4', pending && 'opacity-60', reply.needsReview && 'bg-amber-50/40')}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {reply.contact ? (
              <Link
                href={`/contacts/${reply.contact.id}`}
                className="text-sm font-semibold text-ink-900 hover:text-brand-700"
              >
                {reply.contact.name}
              </Link>
            ) : (
              <span className="text-sm font-semibold text-ink-900">{reply.fromEmail}</span>
            )}
            {intent && <Badge tone={INTENT_TONE[intent]}>{INTENT_LABEL[intent]}</Badge>}
            {/* "Needs a look" is already what the `unclear` label says, so the
                review badge would repeat it on exactly the rows that carry it. */}
            {reply.needsReview && intent !== 'unclear' && <Badge tone="warning">needs a read</Badge>}
            {!reply.contact && <Badge tone="neutral">unmatched</Badge>}
          </div>

          <p className="mt-0.5 text-xs text-ink-500">
            {[reply.contact?.title, reply.contact?.company].filter(Boolean).join(' · ') || reply.fromEmail}
            {reply.sequenceName && <> · from “{reply.sequenceName}”</>}
          </p>

          <p className="mt-2 text-sm font-medium text-ink-800">{reply.subject}</p>
          <p className={cn('mt-1 text-sm text-ink-600 whitespace-pre-line', !expanded && 'line-clamp-2')}>
            {reply.bodyText || '(no text body)'}
          </p>

          {reply.bodyText.length > 160 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
            >
              <ChevronDown className={cn('h-3 w-3 transition', expanded && 'rotate-180')} />
              {expanded ? 'Show less' : 'Show the whole message'}
            </button>
          )}

          {/* Why the machine decided what it did. The classifier is heuristic, so
              the person overruling it needs to see its reasoning, not just its verdict. */}
          {reply.reasons.length > 0 && (
            <p className="mt-2 text-xs text-ink-400">
              Read as {intent ? INTENT_LABEL[intent].toLowerCase() : 'unclassified'}
              {reply.confidence != null && ` (${Math.round(reply.confidence * 100)}% confident)`}
              {' — '}
              {reply.reasons.join('; ')}
            </p>
          )}

          {done && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-700">
              <Check className="h-3.5 w-3.5" />
              {done}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 inline-flex items-center gap-1.5 text-xs text-red-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </p>
          )}

          {reply.contact && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-ink-400 mr-1">It is actually:</span>
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

        <div className="shrink-0 text-right">
          <span className="text-xs text-ink-400">{reply.receivedAt}</span>
          {reply.contact && (
            <Link
              href={`/contacts/${reply.contact.id}`}
              className="mt-2 flex items-center justify-end gap-1 text-xs text-ink-500 hover:text-brand-700"
            >
              <ExternalLink className="h-3 w-3" />
              Record
            </Link>
          )}
        </div>
      </div>
    </li>
  )
}
