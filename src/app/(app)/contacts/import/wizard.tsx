'use client'

import { useState, useTransition, useRef } from 'react'
import Papa from 'papaparse'
import Link from 'next/link'
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Download } from 'lucide-react'
import { Card, Badge } from '@/components/ui'
import { cn, formatNumber } from '@/lib/utils'
import { runImport, type ImportActionResult } from './actions'

const FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: 'email', label: 'Email', required: true },
  { key: 'firstName', label: 'First name', required: false },
  { key: 'lastName', label: 'Last name', required: false },
  { key: 'title', label: 'Job title', required: false },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'linkedinUrl', label: 'LinkedIn URL', required: false },
  { key: 'companyName', label: 'Company name', required: false },
  { key: 'companyDomain', label: 'Company domain', required: false },
  { key: 'country', label: 'Country', required: false },
  { key: 'city', label: 'City', required: false },
]

const ALIASES: Record<string, string> = {
  email: 'email', 'email address': 'email', 'work email': 'email', 'e-mail': 'email',
  'primary email': 'email', 'first name': 'firstName', firstname: 'firstName',
  'last name': 'lastName', lastname: 'lastName', surname: 'lastName',
  title: 'title', 'job title': 'title', position: 'title', headline: 'title',
  phone: 'phone', 'phone number': 'phone', 'mobile phone': 'phone', 'work direct phone': 'phone',
  linkedin: 'linkedinUrl', 'linkedin url': 'linkedinUrl', 'person linkedin url': 'linkedinUrl',
  company: 'companyName', 'company name': 'companyName', organization: 'companyName', account: 'companyName',
  domain: 'companyDomain', website: 'companyDomain', 'company domain': 'companyDomain',
  'company website': 'companyDomain', country: 'country', city: 'city',
}

type Step = 'upload' | 'map' | 'done'

export function ImportWizard() {
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [assignToMe, setAssignToMe] = useState(true)
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update'>('update')
  const [listName, setListName] = useState('')
  const [preview, setPreview] = useState<ImportActionResult | null>(null)
  const [final, setFinal] = useState<ImportActionResult | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    setParseError(null)
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const hs = res.meta.fields ?? []
        const data = res.data.filter((r) => Object.values(r).some((v) => v?.trim()))

        if (!hs.length || !data.length) {
          setParseError('That file has no readable header row or no data rows.')
          return
        }

        const auto: Record<string, string> = {}
        for (const h of hs) {
          const field = ALIASES[h.trim().toLowerCase()]
          if (field && !auto[field]) auto[field] = h
        }

        setFileName(file.name)
        setHeaders(hs)
        setRows(data)
        setMapping(auto)
        setPreview(null)
        setFinal(null)
        setStep('map')
      },
      error: (err) => setParseError(err.message),
    })
  }

  function validate() {
    startTransition(async () => {
      const r = await runImport({ rows, mapping, dryRun: true, assignToMe, onDuplicate })
      setPreview(r)
    })
  }

  function commit() {
    startTransition(async () => {
      const r = await runImport({
        rows, mapping, dryRun: false, assignToMe, onDuplicate,
        listName: listName.trim() || undefined,
      })
      setFinal(r)
      if (r.ok) setStep('done')
    })
  }

  function downloadErrors() {
    const res = final?.ok ? final.result : preview?.ok ? preview.result : null
    if (!res?.errors.length) return
    const csv = Papa.unparse(
      res.errors.map((e) => ({ Row: e.row, Email: e.email, Problem: e.reason })),
      { header: true }
    )
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'import-errors.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // --- step: upload --------------------------------------------------------
  if (step === 'upload') {
    return (
      <Card className="p-8">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const f = e.dataTransfer.files?.[0]
            if (f) handleFile(f)
          }}
          className="border-2 border-dashed border-ink-200 rounded-xl py-14 text-center hover:border-brand-400 transition"
        >
          <div className="mx-auto h-11 w-11 rounded-lg bg-ink-100 grid place-items-center mb-3">
            <FileSpreadsheet className="h-5 w-5 text-ink-500" />
          </div>
          <p className="text-sm font-medium text-ink-900">Drop a CSV here</p>
          <p className="mt-1 text-sm text-ink-500">
            Apollo, Sales Navigator and HubSpot exports are recognised automatically.
          </p>
          <button
            onClick={() => inputRef.current?.click()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
          >
            <Upload className="h-4 w-4" />
            Choose file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
        </div>

        {parseError && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {parseError}
          </p>
        )}

        <p className="mt-4 text-xs text-ink-500">
          Parsing happens in your browser, so nothing is uploaded until you confirm the mapping.
          Up to 5,000 rows per file.
        </p>
      </Card>
    )
  }

  // --- step: done ----------------------------------------------------------
  if (step === 'done' && final?.ok) {
    const r = final.result
    return (
      <Card className="p-8 text-center">
        <div className="mx-auto h-11 w-11 rounded-full bg-emerald-100 grid place-items-center mb-3">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" />
        </div>
        <p className="text-base font-semibold text-ink-900">Import complete</p>
        <p className="mt-1 text-sm text-ink-500">{fileName}</p>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 text-left">
          <Stat label="Created" value={r.created} tone="positive" />
          <Stat label="Updated" value={r.updated} />
          <Stat label="Accounts created" value={r.accountsCreated} />
          <Stat label="Skipped" value={r.skipped} tone={r.skipped ? 'warning' : 'neutral'} />
        </div>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Link
            href="/contacts"
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
          >
            View contacts
          </Link>
          {r.errors.length > 0 && (
            <button
              onClick={downloadErrors}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium hover:bg-ink-50 transition"
            >
              <Download className="h-4 w-4" />
              Download {r.errors.length} error{r.errors.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </Card>
    )
  }

  // --- step: map -----------------------------------------------------------
  const mappedRequired = Boolean(mapping.email)
  const result = preview?.ok ? preview.result : null
  const error = preview && !preview.ok ? preview.error : final && !final.ok ? final.error : null

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-ink-400" />
            <div>
              <p className="text-sm font-medium text-ink-900">{fileName}</p>
              <p className="text-xs text-ink-500">
                {formatNumber(rows.length)} data rows · {headers.length} columns
              </p>
            </div>
          </div>
          <button
            onClick={() => { setStep('upload'); setPreview(null); setFinal(null) }}
            className="text-sm text-ink-500 hover:text-ink-900"
          >
            Choose a different file
          </button>
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4 border-b border-ink-200">
          <h2 className="text-sm font-semibold text-ink-900">Map columns</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Email is required — it is the deduplication key. Anything left unmapped is ignored.
          </p>
        </div>
        <div className="p-5 grid gap-3 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="flex items-center gap-3">
              <label
                htmlFor={`map-${f.key}`}
                className="w-32 shrink-0 text-sm text-ink-700"
              >
                {f.label}
                {f.required && <span className="text-red-500 ml-0.5">*</span>}
              </label>
              <select
                id={`map-${f.key}`}
                value={mapping[f.key] ?? ''}
                onChange={(e) =>
                  setMapping((m) => {
                    const next = { ...m }
                    if (e.target.value) next[f.key] = e.target.value
                    else delete next[f.key]
                    return next
                  })
                }
                className={cn(
                  'flex-1 min-w-0 rounded-lg border bg-white px-2.5 py-1.5 text-sm outline-none transition',
                  f.required && !mapping[f.key]
                    ? 'border-red-300 focus:border-red-500'
                    : 'border-ink-200 focus:border-brand-500'
                )}
              >
                <option value="">— not mapped —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4 border-b border-ink-200">
          <h2 className="text-sm font-semibold text-ink-900">Options</h2>
        </div>
        <div className="p-5 space-y-4">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={assignToMe}
              onChange={(e) => setAssignToMe(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600"
            />
            <span className="text-sm">
              <span className="font-medium text-ink-900">Assign these contacts to me</span>
              <span className="block text-ink-500 text-xs mt-0.5">
                Unassigned contacts stay visible to everyone so inbound can be claimed.
              </span>
            </span>
          </label>

          <fieldset>
            <legend className="text-sm font-medium text-ink-900 mb-1.5">
              When a contact already exists
            </legend>
            <div className="flex gap-2">
              {(['update', 'skip'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setOnDuplicate(mode)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-sm font-medium transition',
                    onDuplicate === mode
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-ink-200 text-ink-600 hover:bg-ink-50'
                  )}
                >
                  {mode === 'update' ? 'Fill in blank fields' : 'Leave untouched'}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-500">
              Existing values are never overwritten — only empty fields are filled.
            </p>
          </fieldset>

          <div>
            <label htmlFor="listName" className="block text-sm font-medium text-ink-900 mb-1.5">
              Add to list <span className="text-ink-400 font-normal">(optional)</span>
            </label>
            <input
              id="listName"
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="e.g. Q3 fintech outbound"
              className="w-full max-w-sm rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm placeholder:text-ink-400 focus:border-brand-500 outline-none transition"
            />
          </div>
        </div>
      </Card>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {result && (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Badge tone="brand">Dry run</Badge>
            <p className="text-sm text-ink-600">Nothing has been written yet.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Will create" value={result.created} tone="positive" />
            <Stat label="Already exist" value={result.updated} />
            <Stat label="Dupes in file" value={result.duplicates} tone={result.duplicates ? 'warning' : 'neutral'} />
            <Stat label="Invalid rows" value={result.skipped} tone={result.skipped ? 'warning' : 'neutral'} />
          </div>

          {result.errors.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-ink-900 inline-flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  {result.errors.length === 1
                    ? '1 row needs attention'
                    : `${result.errors.length} rows need attention`}
                </p>
                <button
                  onClick={downloadErrors}
                  className="inline-flex items-center gap-1.5 text-sm text-brand-700 hover:text-brand-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download report
                </button>
              </div>
              <ul className="rounded-lg border border-ink-200 divide-y divide-ink-100 max-h-48 overflow-y-auto text-sm">
                {result.errors.slice(0, 50).map((e, i) => (
                  <li key={i} className="px-3 py-2 flex gap-3">
                    <span className="text-ink-400 tabular-nums w-14 shrink-0">Row {e.row}</span>
                    <span className="text-ink-700 truncate flex-1">{e.email || '(no email)'}</span>
                    <span className="text-ink-500 truncate max-w-64">{e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={validate}
          disabled={!mappedRequired || pending}
          className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium hover:bg-ink-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {pending && !final ? 'Checking…' : 'Validate without importing'}
        </button>
        <button
          onClick={commit}
          disabled={!mappedRequired || pending}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {pending ? 'Importing…' : `Import ${formatNumber(rows.length)} rows`}
        </button>
        {!mappedRequired && (
          <p className="text-sm text-red-600">Map a column to Email first.</p>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'positive' | 'warning'
}) {
  return (
    <div className="rounded-lg border border-ink-200 px-3 py-2">
      <p className="text-xs text-ink-500">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'positive' && 'text-emerald-600',
          tone === 'warning' && 'text-amber-600',
          tone === 'neutral' && 'text-ink-900'
        )}
      >
        {formatNumber(value)}
      </p>
    </div>
  )
}
