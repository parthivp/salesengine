'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, AlertTriangle } from 'lucide-react'
import { cn, formatNumber } from '@/lib/utils'
import { previewDelete, confirmDelete, type DeleteKind } from './delete-actions'

/**
 * Delete, with the confirmation stating what actually goes.
 *
 * "Are you sure?" asks the operator to agree to an unspecified amount of damage,
 * which is why everyone clicks through it. So this fetches a preview first and
 * names the collateral — the timeline entries, the emails, the deals — before
 * offering the button that does it.
 *
 * The preview is fetched on open rather than rendered with the page, so the counts
 * are current. A list rendered ten minutes ago is not evidence about what deleting
 * now would remove.
 */
export function DeleteButton({
  kind,
  ids,
  label,
  variant = 'icon',
  onDeleted,
}: {
  kind: DeleteKind
  ids: string[]
  /** What to call it in the button, when the button carries text. */
  label?: string
  variant?: 'icon' | 'button'
  /** Where to go afterwards. Defaults to refreshing in place. */
  onDeleted?: string
}) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewDelete>> | null>(null)
  const [cascade, setCascade] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function openDialog() {
    setError(null)
    setPreview(null)
    setCascade(false)
    setOpen(true)
    startTransition(async () => setPreview(await previewDelete({ kind, ids })))
  }

  /**
   * Re-previews when the option changes.
   *
   * Ticking "also delete the contacts" changes the cost by an order of magnitude
   * — their timelines, their mail, their deals — so the confirmation has to
   * restate it. An option that silently changes what a button does, without
   * changing what the button says it will do, is worse than not offering it.
   */
  function setOption(next: boolean) {
    setCascade(next)
    startTransition(async () =>
      setPreview(await previewDelete({ kind, ids, cascadeContacts: next }))
    )
  }

  function run() {
    setError(null)
    startTransition(async () => {
      const r = await confirmDelete({ kind, ids, cascadeContacts: cascade })
      if (!r.ok) {
        setError(r.error)
        return
      }
      setOpen(false)
      if (onDeleted) router.push(onDeleted)
      else router.refresh()
    })
  }

  const p = preview?.ok ? preview.preview : null
  const blocked = Boolean(p?.blockers.length)

  return (
    <>
      {variant === 'icon' ? (
        <button
          onClick={openDialog}
          title="Delete"
          aria-label="Delete"
          className="inline-flex items-center justify-center rounded-lg border border-ink-200 p-1.5 text-ink-400 hover:text-red-700 hover:border-red-300 transition"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : (
        <button
          onClick={openDialog}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:text-red-700 hover:border-red-300 transition"
        >
          <Trash2 className="h-4 w-4" />
          {label ?? 'Delete'}
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4"
          role="dialog"
          aria-modal="true"
          // Clicking the backdrop cancels. Deliberately not the panel itself.
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="w-full max-w-md rounded-xl border border-ink-200 bg-white p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-red-50">
                <AlertTriangle className="h-4 w-4 text-red-600" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink-900">
                  {p ? `Delete ${p.label}?` : 'Delete'}
                </h2>

                {!preview && (
                  <p className="mt-1 text-sm text-ink-500">Working out what this removes…</p>
                )}

                {preview && !preview.ok && (
                  <p className="mt-1 text-sm text-red-700">{preview.error}</p>
                )}

                {p && (
                  <div className="mt-2 space-y-2 text-sm">
                    {p.blockers.map((b, i) => (
                      <p key={i} className="text-amber-800">{b}</p>
                    ))}

                    {!blocked && (
                      <>
                        {p.alsoRemoved.length > 0 ? (
                          <p className="text-ink-700">
                            This also removes{' '}
                            {p.alsoRemoved
                              .map((x) => `${formatNumber(x.count)} ${x.what}`)
                              .join(', ')}
                            .
                          </p>
                        ) : (
                          <p className="text-ink-700">Nothing else is removed with it.</p>
                        )}

                        {p.sideEffects.map((s, i) => (
                          <p key={i} className="text-ink-500">{s}</p>
                        ))}

                        {p.option && (
                          <label className="flex items-start gap-2 rounded-lg border border-ink-200 p-2.5 cursor-pointer hover:bg-ink-50/60">
                            <input
                              type="checkbox"
                              checked={cascade}
                              onChange={(e) => setOption(e.target.checked)}
                              className="mt-0.5 h-3.5 w-3.5 rounded border-ink-300 accent-red-600"
                            />
                            <span className="text-ink-700">{p.option.label}</span>
                          </label>
                        )}

                        <p className="text-ink-500">This cannot be undone.</p>
                      </>
                    )}
                  </div>
                )}

                {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50 transition"
              >
                {blocked ? 'Close' : 'Cancel'}
              </button>
              {!blocked && (
                <button
                  onClick={run}
                  disabled={pending || !p}
                  className={cn(
                    'rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition',
                    'hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {pending ? 'Deleting…' : `Delete ${ids.length > 1 ? formatNumber(ids.length) : ''}`.trim()}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
