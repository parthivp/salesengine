import Papa from 'papaparse'
import { db } from '../db'
import { normalizeLinkedIn } from '../leads/dedupe'

/**
 * LinkedIn's own Connections export.
 *
 * Settings → Data privacy → Get a copy of your data → Connections. LinkedIn emails
 * a zip; `Connections.csv` is inside it. This is a first-party export LinkedIn
 * offers deliberately, unlike the lead-list export people go looking for and never
 * find.
 *
 * It exists here as the backstop to notification-email detection, which covers
 * everything from the day it was switched on and nothing before. The export is the
 * complete list with dates, so importing it once backfills every connection made
 * before the mailbox was connected — and afterwards, catches anything the mailbox
 * missed because notifications were off or the mail was deleted.
 *
 * The file has a quirk: LinkedIn prepends three "Notes:" lines before the real
 * header row. A CSV parser pointed straight at it reads `Notes:` as the only column
 * and returns nothing, which looks exactly like an empty export.
 */

const HEADER_HINT = /first name/i

/** Strips LinkedIn's preamble so the real header row is first. */
export function stripPreamble(text: string): string {
  const lines = text.split(/\r?\n/)
  const headerAt = lines.findIndex((l) => HEADER_HINT.test(l) && /,/.test(l))
  return headerAt > 0 ? lines.slice(headerAt).join('\n') : text
}

export type ConnectionsResult = {
  total: number
  matched: number
  alreadyKnown: number
  unmatched: number
  /** Rows with no usable profile URL — LinkedIn omits it for some connections. */
  withoutProfile: number
}

type Row = Record<string, string>

const col = (row: Row, ...names: string[]): string | undefined => {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.trim().toLowerCase() === n)
    const v = key ? row[key]?.trim() : undefined
    if (v) return v
  }
  return undefined
}

/**
 * Marks contacts as connected from the export.
 *
 * Only ever *adds* a connection date and only where one is missing. The export
 * says nothing about invitations that were declined or are still pending, so
 * absence from it is not evidence of anything and nothing is cleared.
 *
 * Must be called inside a tenant context.
 */
export async function importConnections(
  text: string,
  opts: { dryRun?: boolean } = {}
): Promise<ConnectionsResult> {
  const parsed = Papa.parse<Row>(stripPreamble(text), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  const rows = parsed.data.filter((r) => Object.values(r).some((v) => v?.trim()))
  const result: ConnectionsResult = {
    total: rows.length, matched: 0, alreadyKnown: 0, unmatched: 0, withoutProfile: 0,
  }

  for (const row of rows) {
    const url = col(row, 'url', 'profile url', 'linkedin url')
    const profile = url ? normalizeLinkedIn(url) : null
    if (!profile) {
      result.withoutProfile++
      continue
    }

    const contact = await db().contact.findFirst({
      where: { linkedinUrl: { contains: profile, mode: 'insensitive' } },
      select: { id: true, linkedinConnectedAt: true },
    })
    if (!contact) {
      // Most of an export is people who are not prospects. Counted, not an error.
      result.unmatched++
      continue
    }
    if (contact.linkedinConnectedAt) {
      result.alreadyKnown++
      continue
    }

    const on = col(row, 'connected on')
    // "05 Jul 2026" parses; a blank or unparseable date must not become
    // Invalid Date, which Postgres rejects and which would fail the whole import
    // over a formatting quirk in one row.
    const parsedDate = on ? new Date(on) : null
    const connectedAt =
      parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date()

    if (!opts.dryRun) {
      await db().contact.update({
        where: { id: contact.id },
        data: { linkedinConnectedAt: connectedAt },
      })
    }
    result.matched++
  }

  return result
}
