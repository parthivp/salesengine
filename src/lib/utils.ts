import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatCurrency(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(n)
}

export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? new Date(date) : date
  const diff = Date.now() - d.getTime()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000], ['month', 2_592_000_000], ['day', 86_400_000],
    ['hour', 3_600_000], ['minute', 60_000], ['second', 1000],
  ]
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(-diff / ms), unit)
    }
  }
  return '—'
}

/** "Ada Lovelace" from parts, falling back to the email local part. */
export function displayName(c: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  if (name) return name
  return c.email?.split('@')[0] ?? 'Unknown'
}

export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  return email.slice(at + 1).toLowerCase() || null
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}
