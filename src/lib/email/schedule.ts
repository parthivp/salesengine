import { TZDate } from '@date-fns/tz'
import { addDays, addMinutes, setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns'

/**
 * When may this step actually go out?
 *
 * Pure functions, no I/O, because this is the logic most likely to be wrong in
 * ways nobody notices until a prospect gets an email at 03:00 their time.
 *
 * Precedence, deliberately:
 *   1. the delay the step asks for
 *   2. the sequence's allowed days
 *   3. the sequence's allowed hours, evaluated in the *prospect's* timezone when
 *      known and the tenant's otherwise
 *
 * Mailbox daily caps are enforced separately (`pickMailbox`), because a cap is a
 * question about capacity rather than about time.
 */

export type SendWindow = {
  /** Hour 0–23, inclusive. */
  startHour: number
  /** Hour 0–23, exclusive: 17 means the last send starts at 16:59. */
  endHour: number
  /** 0 = Sunday. */
  days: number[]
  timezone: string
}

export const DEFAULT_WINDOW: SendWindow = {
  startHour: 9,
  endHour: 17,
  days: [1, 2, 3, 4, 5],
  timezone: 'Asia/Kolkata',
}

function partsIn(tz: string, at: Date) {
  const d = new TZDate(at, tz)
  return { hour: d.getHours(), minutes: d.getMinutes(), day: d.getDay() }
}

/** Is `at` inside the window, judged in the window's timezone? */
export function isWithinWindow(at: Date, window: SendWindow): boolean {
  const { hour, day } = partsIn(window.timezone, at)
  if (!window.days.includes(day)) return false
  return hour >= window.startHour && hour < window.endHour
}

/**
 * The first moment at or after `from` that falls inside the window.
 *
 * Walks forward in the window's own timezone rather than doing UTC arithmetic,
 * so DST transitions cannot shift a send by an hour.
 */
export function nextWindowOpening(from: Date, window: SendWindow): Date {
  if (!window.days.length) {
    // A sequence with no sending days can never send. Surfacing that as "far
    // future" beats silently sending anyway.
    return addDays(from, 365)
  }
  if (isWithinWindow(from, window)) return from

  let cursor = new TZDate(from, window.timezone)

  for (let i = 0; i < 14 * 24; i++) {
    const day = cursor.getDay()
    const hour = cursor.getHours()

    if (window.days.includes(day)) {
      if (hour < window.startHour) {
        const opened = setMilliseconds(
          setSeconds(setMinutes(setHours(cursor, window.startHour), 0), 0),
          0
        )
        return new Date(opened.getTime())
      }
      if (hour < window.endHour) {
        return new Date(cursor.getTime())
      }
    }

    // Past the window today (or a non-sending day) — jump to the next day's open.
    cursor = new TZDate(
      setMilliseconds(setSeconds(setMinutes(setHours(addDays(cursor, 1), window.startHour), 0), 0), 0),
      window.timezone
    )
  }

  return addDays(from, 14)
}

/**
 * When the next step should run: apply the delay, then clamp into the window.
 *
 * `jitterMinutes` spreads sends inside the window so a 500-contact step does not
 * fire 500 emails in the same second. This is throughput smoothing for our own
 * infrastructure and the receiving MTAs; it is not an attempt to look human.
 */
export function computeNextRunAt(opts: {
  from?: Date
  delayMinutes: number
  window: SendWindow
  jitterMinutes?: number
}): Date {
  const { from = new Date(), delayMinutes, window, jitterMinutes = 0 } = opts
  const earliest = addMinutes(from, Math.max(0, delayMinutes))
  const opened = nextWindowOpening(earliest, window)

  if (jitterMinutes <= 0) return opened

  // Deterministic spread would defeat the purpose; a bounded random offset is
  // fine here because nothing downstream depends on reproducing the exact time.
  const offset = Math.floor(Math.random() * jitterMinutes)
  const jittered = addMinutes(opened, offset)

  // Jitter must not push the send outside the window it was just clamped into.
  return isWithinWindow(jittered, window) ? jittered : opened
}

export function windowFromSequence(seq: {
  sendWindowStart: number
  sendWindowEnd: number
  sendDays: number[]
}, timezone: string): SendWindow {
  return {
    startHour: seq.sendWindowStart,
    endHour: seq.sendWindowEnd,
    days: seq.sendDays,
    timezone,
  }
}

// ---------------------------------------------------------------------------
// Mailbox capacity
// ---------------------------------------------------------------------------

export type MailboxCapacity = {
  id: string
  dailyCap: number
  sentToday: number
  sentTodayOn: Date | null
  health: 'healthy' | 'warming' | 'throttled' | 'blocked' | 'disconnected'
}

/** Counters reset daily; a stale `sentTodayOn` means today's count is zero. */
export function remainingToday(m: MailboxCapacity, now = new Date()): number {
  const sameDay =
    m.sentTodayOn != null &&
    m.sentTodayOn.getUTCFullYear() === now.getUTCFullYear() &&
    m.sentTodayOn.getUTCMonth() === now.getUTCMonth() &&
    m.sentTodayOn.getUTCDate() === now.getUTCDate()

  const used = sameDay ? m.sentToday : 0
  return Math.max(0, m.dailyCap - used)
}

export function canSend(m: MailboxCapacity, now = new Date()): boolean {
  if (m.health === 'blocked' || m.health === 'disconnected' || m.health === 'throttled') return false
  return remainingToday(m, now) > 0
}

/**
 * Picks the mailbox with the most headroom, so load spreads evenly instead of
 * exhausting one mailbox before touching the next. Returns null when every
 * mailbox is capped — the caller must then reschedule, not send anyway.
 */
export function pickMailbox(
  mailboxes: MailboxCapacity[],
  now = new Date()
): MailboxCapacity | null {
  const eligible = mailboxes.filter((m) => canSend(m, now))
  if (!eligible.length) return null
  return eligible.sort((a, b) => remainingToday(b, now) - remainingToday(a, now))[0]
}

/**
 * Warm-up ramp: 20/day in week one, +20% compounding each week, capped at the
 * mailbox's target. Slow starts are the difference between landing in the inbox
 * and landing in spam for the life of the domain.
 */
export function warmupCap(warmupDay: number, target: number): number {
  const week = Math.floor(Math.max(0, warmupDay) / 7)
  return Math.min(target, Math.ceil(20 * Math.pow(1.2, week)))
}
