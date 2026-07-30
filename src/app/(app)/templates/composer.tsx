'use client'

import { useState, useTransition, useEffect } from 'react'
import { Card, Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Eye, Save, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { saveTemplate, previewTemplate, type PreviewResult } from './actions'

const STARTER_SUBJECT = 'Quick question about {{company}}'
const STARTER_BODY = `Hi {{first_name | there}},

I noticed {{company}} has been growing the team. Teams at that stage usually hit a wall somewhere specific — curious whether that matches what you're seeing.

Worth a short call to compare notes?

{{sender_first_name}}`

export function TemplateComposer() {
  const [name, setName] = useState('')
  const [subject, setSubject] = useState(STARTER_SUBJECT)
  const [body, setBody] = useState(STARTER_BODY)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  /**
   * Clearing the "saved" badge belongs to the edit, not to the effect.
   *
   * It used to be the first line of the debounce effect, which meant a synchronous
   * setState during the effect body and a second render pass on every keystroke.
   * Editing is the event that invalidates the badge, so it clears where the edit
   * happens.
   */
  function edit(set: (v: string) => void) {
    return (value: string) => {
      set(value)
      setSaved(false)
    }
  }

  // Debounced live preview against a real contact.
  useEffect(() => {
    const t = setTimeout(() => {
      startTransition(async () => {
        const r = await previewTemplate({ subject, bodyText: body })
        setPreview(r)
      })
    }, 500)
    return () => clearTimeout(t)
  }, [subject, body])

  function save() {
    setError(null)
    startTransition(async () => {
      const r = await saveTemplate({ name, subject, bodyText: body })
      if (!r.ok) {
        setError(r.error)
        setSaved(false)
      } else {
        setSaved(true)
      }
    })
  }

  const lint = preview?.lint
  const blocked = Boolean(lint?.blocking) || Boolean(preview?.unknown.length)

  return (
    <div className="space-y-4">
      <Card>
        <div className="px-5 py-4 border-b border-ink-200">
          <h2 className="text-sm font-semibold text-ink-900">Compose</h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label htmlFor="tpl-name" className="block text-sm font-medium text-ink-700 mb-1.5">
              Template name
            </label>
            <input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Logistics — first touch"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
            />
          </div>

          <div>
            <label htmlFor="tpl-subject" className="block text-sm font-medium text-ink-700 mb-1.5">
              Subject
            </label>
            <input
              id="tpl-subject"
              value={subject}
              onChange={(e) => edit(setSubject)(e.target.value)}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm font-mono focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
            />
            <p className="mt-1 text-xs text-ink-400">
              {subject.length} characters — mobile clients truncate around 40.
            </p>
          </div>

          <div>
            <label htmlFor="tpl-body" className="block text-sm font-medium text-ink-700 mb-1.5">
              Body
            </label>
            <textarea
              id="tpl-body"
              value={body}
              onChange={(e) => edit(setBody)(e.target.value)}
              rows={12}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm font-mono leading-relaxed focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition"
            />
            <p className="mt-1 text-xs text-ink-400">
              {body.trim().split(/\s+/).filter(Boolean).length} words. An unsubscribe footer is added
              automatically at send time.
            </p>
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={pending || name.trim().length < 2 || blocked}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <Save className="h-4 w-4" />
              {pending ? 'Saving…' : 'Save template'}
            </button>
            {saved && (
              <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                Saved
              </span>
            )}
            {blocked && (
              <span className="text-sm text-red-700">
                Fix the blocking issues before saving.
              </span>
            )}
          </div>
        </div>
      </Card>

      {preview && (
        <Card>
          <div className="px-5 py-4 border-b border-ink-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-ink-400" />
              <h2 className="text-sm font-semibold text-ink-900">Preview</h2>
              <span className="text-xs text-ink-500">rendered against a real contact</span>
            </div>
            <Badge
              tone={blocked ? 'danger' : lint!.score > 20 ? 'warning' : 'success'}
            >
              risk {lint!.score}/100
            </Badge>
          </div>

          <div className="p-5">
            <div className="rounded-lg border border-ink-200 bg-ink-50/50 p-4">
              <p className="text-xs text-ink-500">Subject</p>
              <p className="text-sm font-medium text-ink-900">{preview.subject || '(empty)'}</p>
              <hr className="my-3 border-ink-200" />
              <p className="text-sm text-ink-800 whitespace-pre-line leading-relaxed">
                {preview.body || '(empty)'}
              </p>
              <p className="mt-4 text-xs text-ink-400">— Unsubscribe</p>
            </div>

            {preview.unknown.length > 0 && (
              <p className="mt-3 text-sm text-red-700">
                Unknown merge {preview.unknown.length === 1 ? 'tag' : 'tags'}:{' '}
                {preview.unknown.map((t) => `{{${t}}}`).join(', ')}
              </p>
            )}

            {preview.unresolved.length > 0 && (
              <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
                <strong>
                  {preview.unresolved.map((t) => `{{${t}}}`).join(', ')}
                </strong>{' '}
                did not resolve for this contact. The engine refuses to send rather than leaving a
                gap — add a fallback like <code>{'{{'}{preview.unresolved[0]} | there{'}}'}</code>.
              </p>
            )}

            {lint!.findings.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {lint!.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <AlertTriangle
                      className={cn(
                        'h-3.5 w-3.5 mt-0.5 shrink-0',
                        f.severity === 'error' ? 'text-red-500'
                        : f.severity === 'warning' ? 'text-amber-500'
                        : 'text-ink-400'
                      )}
                    />
                    <span
                      className={
                        f.severity === 'error' ? 'text-red-700'
                        : f.severity === 'warning' ? 'text-amber-800'
                        : 'text-ink-600'
                      }
                    >
                      {f.message}
                      {f.detail && <span className="text-ink-500"> — {f.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {lint!.findings.length === 0 && (
              <p className="mt-4 inline-flex items-center gap-1.5 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                No deliverability issues found.
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
