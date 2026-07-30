/**
 * Merge-tag rendering.
 *
 * Syntax: {{first_name}} or {{first_name | there}} for a fallback.
 *
 * Two rules that matter more than the feature itself:
 *
 *  1. An unresolved tag must never reach a prospect. "Hi {{first_name}}," in a
 *     real send is the single most recognisable sign of bulk outreach, and it
 *     costs more replies than the personalisation gained. `render` reports
 *     unresolved tags so the caller can refuse to send.
 *
 *  2. Values are escaped when rendering HTML. Merge values come from CSV imports
 *     and public form submissions, i.e. from strangers — a contact whose company
 *     is `<script>` must not become an injection vector in our own UI previews.
 */

export type MergeValues = Record<string, string | null | undefined>

const TAG = /\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi

export type RenderResult = {
  text: string
  unresolved: string[]
  usedFallback: string[]
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function render(
  template: string,
  values: MergeValues,
  opts: { html?: boolean } = {}
): RenderResult {
  const unresolved: string[] = []
  const usedFallback: string[] = []

  const text = template.replace(TAG, (_match, rawKey: string, fallback?: string) => {
    const key = rawKey.toLowerCase()
    const value = values[key]

    if (value != null && String(value).trim() !== '') {
      const v = String(value).trim()
      return opts.html ? escapeHtml(v) : v
    }

    if (fallback != null && fallback !== '') {
      usedFallback.push(key)
      return opts.html ? escapeHtml(fallback) : fallback
    }

    unresolved.push(key)
    return '' // leave a gap rather than the raw tag, in case a caller ignores `unresolved`
  })

  return { text, unresolved: [...new Set(unresolved)], usedFallback: [...new Set(usedFallback)] }
}

/** The tag vocabulary offered in the template editor. */
export const AVAILABLE_TAGS = [
  { key: 'first_name', label: 'First name', example: 'Priya' },
  { key: 'last_name', label: 'Last name', example: 'Raman' },
  { key: 'full_name', label: 'Full name', example: 'Priya Raman' },
  { key: 'email', label: 'Email', example: 'priya@northwind.io' },
  { key: 'title', label: 'Job title', example: 'VP of Sales' },
  { key: 'company', label: 'Company', example: 'Northwind Logistics' },
  { key: 'company_domain', label: 'Company domain', example: 'northwind.io' },
  { key: 'industry', label: 'Industry', example: 'Logistics' },
  { key: 'city', label: 'City', example: 'Bengaluru' },
  { key: 'country', label: 'Country', example: 'India' },
  { key: 'sender_name', label: 'Your name', example: 'Rohan Desai' },
  { key: 'sender_first_name', label: 'Your first name', example: 'Rohan' },
  { key: 'sender_email', label: 'Your email', example: 'rohan@acme.test' },
] as const

export type ContactLike = {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  title?: string | null
  city?: string | null
  country?: string | null
  account?: { name?: string | null; domain?: string | null; industry?: string | null } | null
}

export type SenderLike = { name?: string | null; email?: string | null }

export function valuesFor(contact: ContactLike, sender: SenderLike): MergeValues {
  const full = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
  return {
    first_name: contact.firstName ?? undefined,
    last_name: contact.lastName ?? undefined,
    full_name: full || undefined,
    email: contact.email ?? undefined,
    title: contact.title ?? undefined,
    company: contact.account?.name ?? undefined,
    company_domain: contact.account?.domain ?? undefined,
    industry: contact.account?.industry ?? undefined,
    city: contact.city ?? undefined,
    country: contact.country ?? undefined,
    sender_name: sender.name ?? undefined,
    sender_first_name: sender.name?.split(' ')[0] ?? undefined,
    sender_email: sender.email ?? undefined,
  }
}

/** Every tag referenced by a template, whether or not it resolves. */
export function extractTags(template: string): string[] {
  const found: string[] = []
  for (const m of template.matchAll(TAG)) found.push(m[1].toLowerCase())
  return [...new Set(found)]
}

/** Tags the editor does not recognise — almost always a typo. */
export function unknownTags(template: string): string[] {
  const known = new Set<string>(AVAILABLE_TAGS.map((t) => t.key))
  return extractTags(template).filter((t) => !known.has(t))
}
