'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import { cn, formatNumber } from '@/lib/utils'
import { Badge, Card } from '@/components/ui'
import { Upload, AlertTriangle, Check, FileCode2 } from 'lucide-react'
import { readPage, importParsed } from './actions'
import type { ParsedLead } from '@/lib/linkedin/parse-salesnav'

/**
 * Read a saved Sales Navigator page, check what came out, import what you keep.
 *
 * The review step is the feature, not a formality. A parser reading someone else's
 * markup is a guess that is usually right, and the difference between "usually
 * right" and "safe to import" is a person looking at it. So every row is shown with
 * every field it found, each cell is editable, and rows can be dropped — and a row
 * with no profile URL cannot be imported at all, because there would be nothing to
 * open when it reaches the queue.
 */

type Row = {
  key: string
  keep: boolean
  linkedinUrl: string
  firstName: string
  lastName: string
  title: string
  companyName: string
  companyDomain: string
  city: string
  email: string
  /** Not from the page — typed by you, because the drafts read them. */
  industry: string
  employeeCount: string
  nameTruncated: boolean
  missing: string[]
}

const FIELDS: { key: keyof Row; label: string; width: string }[] = [
  { key: 'firstName', label: 'First', width: 'w-24' },
  { key: 'lastName', label: 'Last', width: 'w-28' },
  { key: 'title', label: 'Title', width: 'w-52' },
  { key: 'companyName', label: 'Company', width: 'w-44' },
  { key: 'city', label: 'Location', width: 'w-44' },
  { key: 'industry', label: 'Industry', width: 'w-36' },
  { key: 'employeeCount', label: 'Headcount', width: 'w-24' },
  { key: 'email', label: 'Email', width: 'w-48' },
]

function toRow(l: ParsedLead, i: number): Row {
  return {
    key: l.leadId ?? `row-${i}`,
    keep: Boolean(l.leadUrl),
    linkedinUrl: l.leadUrl ?? '',
    firstName: l.firstName ?? '',
    lastName: l.lastName ?? '',
    title: l.title ?? '',
    companyName: l.companyName ?? '',
    companyDomain: l.companyDomain ?? '',
    city: l.location ?? '',
    email: l.emailInBio ?? '',
    industry: '',
    employeeCount: '',
    nameTruncated: l.nameTruncated,
    missing: l.missing,
  }
}

export function PasteImport() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [kind, setKind] = useState<string>('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [listName, setListName] = useState('')
  const [outcome, setOutcome] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    setError(null)
    setOutcome(null)
    file
      .text()
      .then((html) =>
        startTransition(async () => {
          const r = await readPage(html)
          if (!r.ok) {
            setError(r.error)
            setRows(null)
            return
          }
          setKind(r.kind)
          setWarnings(r.warnings)
          setRows(r.leads.map(toRow))
        })
      )
      .catch(() => setError('That file could not be read.'))
  }

  function edit(key: string, field: keyof Row, value: string | boolean) {
    setRows((prev) =>
      prev?.map((r) => (r.key === key ? { ...r, [field]: value } : r)) ?? prev
    )
  }

  function run(dryRun: boolean) {
    if (!rows) return
    setError(null)
    setOutcome(null)
    const keep = rows.filter((r) => r.keep && r.linkedinUrl)
    if (!keep.length) {
      setError('Nothing is ticked.')
      return
    }
    startTransition(async () => {
      const r = await importParsed({
        rows: keep.map(({ key, keep: _k, nameTruncated: _n, missing: _m, ...rest }) => {
          void key; void _k; void _n; void _m
          return rest
        }),
        listName: listName.trim() || undefined,
        assignToMe: true,
        dryRun,
      })
      if (!r.ok) {
        setError(r.error)
        return
      }
      const x = r.result
      setOutcome(
        dryRun
          ? `Dry run: ${x.created} would be added, ${x.duplicates} already exist, ${x.skipped} would be skipped.`
          : `Imported. ${x.created} added, ${x.duplicates} already existed, ${x.accountsCreated} companies created.` +
              (x.withoutEmail ? ` ${x.withoutEmail} have no email — they are LinkedIn-only contacts.` : '')
      )
      if (!dryRun) setRows((prev) => prev?.map((p) => ({ ...p, keep: false })) ?? prev)
    })
  }

  const kept = rows?.filter((r) => r.keep).length ?? 0

  return (
    <div className="space-y-4">
      {/* --- step 1: the file ------------------------------------------------ */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">1. Save the page, then pick the file</h2>
        <ol className="mt-2 space-y-1 text-sm text-ink-600 list-decimal pl-5">
          <li>Open a Sales Navigator search, or one person&rsquo;s page, in your browser.</li>
          <li>
            On a search, <strong>scroll to the bottom of the list first</strong> — the page only
            keeps the rows you have scrolled past.
          </li>
          <li>
            Press <kbd className="rounded border border-ink-300 px-1 text-xs">Ctrl</kbd>+
            <kbd className="rounded border border-ink-300 px-1 text-xs">S</kbd> and save as{' '}
            <strong>Webpage, Complete</strong>.
          </li>
          <li>Pick that .html file below.</li>
        </ol>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".html,.htm,text/html"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
          >
            <Upload className="h-4 w-4" />
            {pending && !rows ? 'Reading…' : 'Choose a saved page'}
          </button>
          {rows && (
            <span className="inline-flex items-center gap-1.5 text-sm text-ink-500">
              <FileCode2 className="h-4 w-4" />
              read as a {kind === 'search' ? 'results list' : 'single profile'}
            </span>
          )}
        </div>

        <p className="mt-3 text-xs text-ink-400">
          The file is read here and nothing is sent to LinkedIn. This app never opens
          linkedin.com on your behalf.
        </p>
      </Card>

      {error && (
        <Card className="p-4 border-red-200 bg-red-50/60">
          <p className="inline-flex items-start gap-2 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        </Card>
      )}

      {warnings.map((w, i) => (
        <Card key={i} className="p-4 border-amber-200 bg-amber-50/60">
          <p className="text-sm text-amber-900">{w}</p>
        </Card>
      ))}

      {/* --- step 2: review -------------------------------------------------- */}
      {rows && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">2. Check what it read</h2>
              <p className="mt-0.5 text-xs text-ink-500">
                Every cell is editable. Untick anyone you do not want.
              </p>
            </div>
            <span className="text-sm text-ink-600">
              {formatNumber(kept)} of {formatNumber(rows.length)} ticked
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={rows.every((r) => r.keep)}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev?.map((r) => ({ ...r, keep: e.target.checked && Boolean(r.linkedinUrl) })) ?? prev
                        )
                      }
                      aria-label="Keep everyone"
                      className="h-3.5 w-3.5 rounded border-ink-300 accent-brand-600"
                    />
                  </th>
                  {FIELDS.map((f) => (
                    <th key={String(f.key)} className="px-2 py-2 font-medium">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.key} className={cn(!r.keep && 'opacity-45')}>
                    <td className="px-3 py-1.5 align-top">
                      <input
                        type="checkbox"
                        checked={r.keep}
                        disabled={!r.linkedinUrl}
                        onChange={(e) => edit(r.key, 'keep', e.target.checked)}
                        aria-label={`Keep ${r.firstName} ${r.lastName}`.trim()}
                        className="mt-1.5 h-3.5 w-3.5 rounded border-ink-300 accent-brand-600 disabled:opacity-40"
                      />
                    </td>
                    {FIELDS.map((f) => (
                      <td key={String(f.key)} className="px-2 py-1.5 align-top">
                        <input
                          value={String(r[f.key] ?? '')}
                          onChange={(e) => edit(r.key, f.key, e.target.value)}
                          aria-label={`${f.label} for ${r.firstName || 'this row'}`}
                          className={cn(
                            f.width,
                            'rounded-md border border-transparent bg-ink-50/60 px-2 py-1 text-sm',
                            'hover:border-ink-200 focus:border-brand-400 focus:bg-white focus:outline-none',
                            // Empty industry and headcount are the two that visibly
                            // cost you: without them the drafts fall back to
                            // location and the card is labelled generic.
                            !r[f.key] && (f.key === 'industry' || f.key === 'employeeCount') && 'bg-amber-50/70'
                          )}
                        />
                        {f.key === 'lastName' && r.nameTruncated && (
                          <p className="mt-0.5 w-28 text-[11px] leading-tight text-ink-400">
                            LinkedIn hid the surname
                          </p>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-ink-100 px-5 py-3">
            <p className="text-xs text-ink-500">
              <strong className="text-ink-700">Industry and headcount are not on the page</strong> —
              LinkedIn does not put them there. They are what the connection notes are drafted from,
              so a row without them produces a{' '}
              <Badge tone="warning">generic</Badge> card. Sales Navigator shows both beside the
              company name; typing them here is a few seconds each and changes what gets sent.
            </p>
          </div>
        </Card>
      )}

      {/* --- step 3: import -------------------------------------------------- */}
      {rows && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-ink-900">3. Import</h2>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs text-ink-500">Add them to a list (optional)</span>
              <input
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                placeholder="e.g. IP lawyers, North America"
                className="mt-1 block w-72 rounded-lg border border-ink-200 px-3 py-2 text-sm placeholder:text-ink-400 focus:border-brand-400 focus:outline-none"
              />
            </label>
            <button
              onClick={() => run(true)}
              disabled={pending || kept === 0}
              className="rounded-lg border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50 transition"
            >
              Dry run
            </button>
            <button
              onClick={() => run(false)}
              disabled={pending || kept === 0}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition"
            >
              {pending ? 'Working…' : `Import ${formatNumber(kept)}`}
            </button>
          </div>

          {outcome && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
              <p className="inline-flex items-start gap-2 text-sm text-emerald-900">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                {outcome}
              </p>
              <p className="mt-2 text-sm text-emerald-800">
                Importing does not queue anyone. Go to the{' '}
                <Link href="/linkedin" className="underline font-medium">LinkedIn queue</Link> and
                press <strong>Build target list</strong> when you want cards for them.
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
