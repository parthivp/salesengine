'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui'
import { RefreshCw, Plus } from 'lucide-react'
import { addMailbox, recheckMailbox, type MailboxResult } from './actions'

export function AddMailbox() {
  const [email, setEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [target, setTarget] = useState(200)
  const [result, setResult] = useState<MailboxResult | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setResult(null)
    startTransition(async () => {
      setResult(await addMailbox({ email, fromName, warmupTarget: target }))
    })
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-ink-200">
        <h2 className="text-sm font-semibold text-ink-900">Add a mailbox</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          DNS is checked before the mailbox is created.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <div>
          <label htmlFor="mb-email" className="block text-xs font-medium text-ink-600 mb-1">
            Sending address
          </label>
          <input
            id="mb-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="outbound@yourdomain.com"
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>
        <div>
          <label htmlFor="mb-name" className="block text-xs font-medium text-ink-600 mb-1">
            From name
          </label>
          <input
            id="mb-name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Rohan Desai"
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>
        <div>
          <label htmlFor="mb-target" className="block text-xs font-medium text-ink-600 mb-1">
            Daily cap once warm
          </label>
          <input
            id="mb-target"
            type="number"
            min={20}
            max={2000}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm focus:border-brand-500 outline-none"
          />
        </div>

        <button
          onClick={submit}
          disabled={pending || !email.includes('@') || fromName.trim().length < 1}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
        >
          <Plus className="h-4 w-4" />
          {pending ? 'Checking DNS…' : 'Add mailbox'}
        </button>

        {result && !result.ok && (
          <p role="alert" className="text-xs text-red-700">{result.error}</p>
        )}
        {result?.ok && (
          <div className="text-xs space-y-1">
            <p className="text-ink-700">
              SPF {result.auth?.spf.ok ? '✓' : '✗'} · DKIM {result.auth?.dkim.ok ? '✓' : '✗'} ·
              DMARC {result.auth?.dmarc.ok ? '✓' : '✗'}
            </p>
            {result.blockers?.length ? (
              <>
                <p className="text-red-700 font-medium">
                  Added, but blocked from sending until these are fixed:
                </p>
                <ul className="list-disc list-inside text-red-700">
                  {result.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </>
            ) : (
              <p className="text-emerald-700">
                Added and warming. Starts at 20/day and ramps weekly.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

export function RecheckButton({ mailboxId }: { mailboxId: string }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(async () => { await recheckMailbox(mailboxId) })}
      disabled={pending}
      title="Re-check SPF, DKIM and DMARC"
      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50 transition shrink-0"
    >
      <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
      {pending ? 'Checking' : 'Re-check'}
    </button>
  )
}
