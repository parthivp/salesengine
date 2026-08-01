/**
 * Measures the Sales Navigator parser against the saved fixtures and prints a
 * per-field hit rate.
 *
 * The point is to answer "how accurate is this, really" with a number rather than
 * an impression, and to re-answer it in one command the next time LinkedIn changes
 * the page.
 *
 * Split by page kind, because the two pages carry different fields — a results row
 * has no headline and a lead page has no other people on it. Pooling them produces
 * a number that describes neither.
 *
 *     npx tsx scripts/parse-report.ts
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseSalesNavigator, REPORTED_FIELDS, type ParsedLead, type ParsedPage,
} from '../src/lib/linkedin/parse-salesnav'

const DIR = join(process.cwd(), 'fixtures', 'salesnav')

const files = readdirSync(DIR).filter((f) => f.endsWith('.html')).sort()
const byKind = new Map<ParsedPage['kind'], ParsedLead[]>()

for (const file of files) {
  const page = parseSalesNavigator(readFileSync(join(DIR, file), 'utf8'))
  console.log(`\n${file}  →  ${page.kind}, ${page.leads.length} lead(s)`)
  for (const w of page.warnings) console.log(`  ! ${w}`)
  for (const lead of page.leads) {
    const bits = [lead.title, lead.companyName, lead.location].filter(Boolean).join(' · ')
    console.log(`    ${(lead.fullName ?? '(no name)').padEnd(24)} ${bits}`)
    if (lead.nameTruncated) console.log(`      surname withheld by LinkedIn`)
  }
  byKind.set(page.kind, [...(byKind.get(page.kind) ?? []), ...page.leads])
}

for (const [kind, leads] of byKind) {
  console.log(`\n\n${kind} pages — ${leads.length} ${leads.length === 1 ? 'person' : 'people'}\n`)
  console.log('field'.padEnd(16) + 'found'.padEnd(10) + 'rate'.padEnd(8) + 'from')
  console.log('-'.repeat(56))
  for (const f of REPORTED_FIELDS) {
    const hits = leads.filter((l) => l[f] !== null)
    const sources = [...new Set(hits.map((l) => l.found[f]).filter(Boolean))]
    const rate = leads.length ? Math.round((hits.length / leads.length) * 100) : 0
    console.log(
      f.padEnd(16) +
        `${hits.length}/${leads.length}`.padEnd(10) +
        `${rate}%`.padEnd(8) +
        sources.join(', ')
    )
  }
  const trunc = leads.filter((l) => l.nameTruncated).length
  if (trunc) console.log(`\n  ${trunc} of ${leads.length} had the surname withheld.`)
}

console.log(
  '\n\nNot on either page at any rate: email, company headcount, company industry.\n' +
    'Headcount and industry are what the LinkedIn drafts read, so a card built only\n' +
    'from a parsed page is still drafted from title and location.\n'
)
