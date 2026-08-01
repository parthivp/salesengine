import { describe, it, expect } from 'vitest'
import { render, valuesFor, extractTags, unknownTags } from '../email/merge'
import {
  isWithinWindow, nextWindowOpening, computeNextRunAt, remainingToday,
  canSend, pickMailbox, warmupCap, type SendWindow, type MailboxCapacity,
} from '../email/schedule'
import { lintContent, assessReputation, maySend } from '../email/deliverability'
import { textToHtml, signToken, verifyToken, rewriteLinksForTracking, clickUrl } from '../email/send'

const IST: SendWindow = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' }

/**
 * Builds an instant from an IST wall-clock time. IST is UTC+5:30 year-round with
 * no DST, so the conversion is exact.
 *
 * Reference calendar used below:
 *   Thu 30 Jul 2026, Fri 31 Jul, Sat 1 Aug, Sun 2 Aug, Mon 3 Aug.
 */
function ist(month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, month - 1, day, hour - 5, minute - 30))
}

const THU = (h: number, m = 0) => ist(7, 30, h, m)
const FRI = (h: number, m = 0) => ist(7, 31, h, m)
const SAT = (h: number, m = 0) => ist(8, 1, h, m)
const SUN = (h: number, m = 0) => ist(8, 2, h, m)
const MON = (h: number, m = 0) => ist(8, 3, h, m)

describe('merge tags', () => {
  const contact = {
    firstName: 'Priya', lastName: 'Raman', email: 'priya@northwind.io',
    title: 'VP of Sales', city: 'Bengaluru', country: 'India',
    account: { name: 'Northwind Logistics', domain: 'northwind.io', industry: 'Logistics' },
  }
  const sender = { name: 'Rohan Desai', email: 'rohan@acme.test' }

  it('substitutes values', () => {
    const r = render('Hi {{first_name}} at {{company}}', valuesFor(contact, sender))
    expect(r.text).toBe('Hi Priya at Northwind Logistics')
    expect(r.unresolved).toEqual([])
  })

  it('uses a fallback when the value is missing', () => {
    const r = render('Hi {{first_name | there}}', valuesFor({ ...contact, firstName: null }, sender))
    expect(r.text).toBe('Hi there')
    expect(r.usedFallback).toEqual(['first_name'])
    expect(r.unresolved).toEqual([])
  })

  it('treats whitespace-only values as missing', () => {
    const r = render('Hi {{first_name | there}}', { first_name: '   ' })
    expect(r.text).toBe('Hi there')
  })

  it('reports unresolved tags so the caller can refuse to send', () => {
    const r = render('Hi {{first_name}}, saw {{company}}', { first_name: 'Priya' })
    expect(r.unresolved).toEqual(['company'])
    // Never leave the raw tag in the body — that is the giveaway.
    expect(r.text).not.toContain('{{')
  })

  it('escapes values in HTML mode', () => {
    const r = render('Company: {{company}}', { company: '<script>alert(1)</script>' }, { html: true })
    expect(r.text).toBe('Company: &lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('does not escape in plain-text mode', () => {
    const r = render('{{company}}', { company: 'Smith & Co' })
    expect(r.text).toBe('Smith & Co')
  })

  it('is case- and space-insensitive in tag names', () => {
    const r = render('{{ First_Name }}', { first_name: 'Priya' })
    expect(r.text).toBe('Priya')
  })

  it('flags tags the editor does not know about', () => {
    expect(unknownTags('Hi {{first_name}} {{favourite_colour}}')).toEqual(['favourite_colour'])
    expect(extractTags('{{a}} {{b|x}} {{a}}')).toEqual(['a', 'b'])
  })
})

describe('sending windows', () => {
  it('accepts a Thursday mid-morning', () => {
    expect(isWithinWindow(THU(10), IST)).toBe(true)
  })

  it('rejects before opening, after closing, and at the closing hour', () => {
    expect(isWithinWindow(THU(8, 59), IST)).toBe(false)
    expect(isWithinWindow(THU(17, 0), IST)).toBe(false)
    expect(isWithinWindow(THU(21), IST)).toBe(false)
  })

  it('rejects weekends', () => {
    expect(isWithinWindow(SAT(10), IST)).toBe(false)
    expect(isWithinWindow(SUN(10), IST)).toBe(false)
  })

  it('moves an early-morning send to the opening hour the same day', () => {
    expect(nextWindowOpening(THU(6), IST).getTime()).toBe(THU(9).getTime())
  })

  it('moves an evening send to the next morning', () => {
    expect(nextWindowOpening(THU(22), IST).getTime()).toBe(FRI(9).getTime())
  })

  it('skips the weekend entirely', () => {
    // Friday 20:00 -> Monday 09:00, not Saturday.
    expect(nextWindowOpening(FRI(20), IST).getTime()).toBe(MON(9).getTime())
    expect(nextWindowOpening(SAT(10), IST).getTime()).toBe(MON(9).getTime())
    expect(nextWindowOpening(SUN(23), IST).getTime()).toBe(MON(9).getTime())
  })

  it('leaves a time already inside the window untouched', () => {
    const at = THU(14, 37)
    expect(nextWindowOpening(at, IST).getTime()).toBe(at.getTime())
  })

  it('respects the prospect timezone, not the server', () => {
    const nyWindow: SendWindow = { ...IST, timezone: 'America/New_York' }
    // 09:30 IST on Thursday is 00:00 EDT — the middle of the night in New York.
    const at = THU(9, 30)
    expect(isWithinWindow(at, IST)).toBe(true)
    expect(isWithinWindow(at, nyWindow)).toBe(false)
  })

  it('does not send at all when no days are enabled', () => {
    const never: SendWindow = { ...IST, days: [] }
    const next = nextWindowOpening(THU(10), never)
    expect(next.getTime()).toBeGreaterThan(THU(10).getTime() + 300 * 86_400_000)
  })

  it('applies the delay before clamping to the window', () => {
    // Thursday 16:30 + 60 minutes = 17:30, outside the window -> Friday 09:00
    const next = computeNextRunAt({ from: THU(16, 30), delayMinutes: 60, window: IST })
    expect(next.getTime()).toBe(FRI(9).getTime())
  })

  it('pushes a Friday-evening delay to Monday', () => {
    const next = computeNextRunAt({ from: FRI(16, 45), delayMinutes: 60, window: IST })
    expect(next.getTime()).toBe(MON(9).getTime())
  })

  it('keeps jitter inside the window', () => {
    for (let i = 0; i < 50; i++) {
      const next = computeNextRunAt({
        from: THU(16, 55), delayMinutes: 0, window: IST, jitterMinutes: 30,
      })
      expect(isWithinWindow(next, IST)).toBe(true)
    }
  })
})

describe('mailbox capacity', () => {
  const base: MailboxCapacity = {
    id: 'm1', dailyCap: 50, sentToday: 0, sentTodayOn: null, health: 'healthy',
  }
  const now = new Date('2026-07-30T10:00:00Z')

  it('treats a stale counter as zero sent today', () => {
    const stale = { ...base, sentToday: 50, sentTodayOn: new Date('2026-07-29T10:00:00Z') }
    expect(remainingToday(stale, now)).toBe(50)
    expect(canSend(stale, now)).toBe(true)
  })

  it('counts sends made today', () => {
    const today = { ...base, sentToday: 48, sentTodayOn: now }
    expect(remainingToday(today, now)).toBe(2)
  })

  it('refuses when capped', () => {
    expect(canSend({ ...base, sentToday: 50, sentTodayOn: now }, now)).toBe(false)
  })

  it('refuses blocked, throttled and disconnected mailboxes regardless of headroom', () => {
    for (const health of ['blocked', 'throttled', 'disconnected'] as const) {
      expect(canSend({ ...base, health }, now)).toBe(false)
    }
  })

  it('picks the mailbox with the most headroom, spreading load', () => {
    const chosen = pickMailbox(
      [
        { ...base, id: 'nearly-full', sentToday: 45, sentTodayOn: now },
        { ...base, id: 'fresh', sentToday: 5, sentTodayOn: now },
        { ...base, id: 'blocked', health: 'blocked' },
      ],
      now
    )
    expect(chosen?.id).toBe('fresh')
  })

  it('returns null when everything is capped, so the caller reschedules', () => {
    const chosen = pickMailbox([{ ...base, sentToday: 50, sentTodayOn: now }], now)
    expect(chosen).toBeNull()
  })

  it('ramps the warm-up cap weekly and never past the target', () => {
    expect(warmupCap(0, 200)).toBe(20)
    expect(warmupCap(6, 200)).toBe(20)
    expect(warmupCap(7, 200)).toBe(24)
    expect(warmupCap(14, 200)).toBe(29)
    expect(warmupCap(365, 200)).toBe(200)
    expect(warmupCap(365, 40)).toBe(40)
  })
})

describe('content linting', () => {
  const clean = {
    subject: 'Question about your fulfilment lead times',
    bodyText:
      'Hi Priya, I noticed Northwind opened a second warehouse this quarter. ' +
      'Teams at that stage usually hit a wall coordinating inbound scheduling across sites. ' +
      'Worth a short call to compare notes on how others handled it? Happy to share what we saw.',
    hasUnsubscribe: true,
  }

  it('passes a normal cold email', () => {
    const r = lintContent(clean)
    expect(r.blocking).toBe(false)
    expect(r.score).toBeLessThan(20)
  })

  it('blocks an empty subject', () => {
    const r = lintContent({ ...clean, subject: '' })
    expect(r.blocking).toBe(true)
    expect(r.findings.some((f) => f.message.includes('Subject is empty'))).toBe(true)
  })

  it('blocks a missing unsubscribe mechanism', () => {
    const r = lintContent({ ...clean, hasUnsubscribe: false })
    expect(r.blocking).toBe(true)
  })

  it('blocks a shouty subject', () => {
    const r = lintContent({ ...clean, subject: 'URGENT OFFER INSIDE NOW' })
    expect(r.blocking).toBe(true)
  })

  it('catches stacked spam phrases', () => {
    const r = lintContent({
      ...clean,
      subject: 'Act now — limited time offer',
      bodyText: 'Click here to claim your free gift and earn extra cash risk free. Guarantee!',
    })
    expect(r.blocking).toBe(true)
    expect(r.score).toBeGreaterThan(30)
  })

  it('warns on link density without blocking', () => {
    const r = lintContent({
      ...clean,
      bodyText: `${clean.bodyText} https://a.test https://b.test https://c.test https://d.test`,
    })
    expect(r.blocking).toBe(false)
    expect(r.findings.some((f) => f.message.includes('links'))).toBe(true)
  })
})

describe('reputation', () => {
  it('stays quiet below the volume floor, where rates are noise', () => {
    expect(assessReputation({ sent: 10, bounced: 4, complained: 1 }).action).toBe('ok')
  })

  it('pauses at the AWS complaint limit', () => {
    expect(assessReputation({ sent: 1000, bounced: 0, complained: 1 }).action).toBe('pause')
  })

  it('pauses at a 5% bounce rate', () => {
    expect(assessReputation({ sent: 1000, bounced: 50, complained: 0 }).action).toBe('pause')
  })

  it('warns before it pauses', () => {
    const v = assessReputation({ sent: 1000, bounced: 35, complained: 0 })
    expect(v.action).toBe('warn')
    expect(v.reasons[0]).toContain('3.5%')
  })

  it('is clean on healthy numbers', () => {
    expect(assessReputation({ sent: 5000, bounced: 40, complained: 1 }).action).toBe('ok')
  })

  it('blocks sending without SPF or DKIM, but not without DMARC', () => {
    expect(
      maySend({ spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: false } }).allowed
    ).toBe(true)
    expect(
      maySend({ spf: { ok: false, reason: 'none' }, dkim: { ok: true }, dmarc: { ok: true } }).allowed
    ).toBe(false)
    expect(
      maySend({ spf: { ok: true }, dkim: { ok: false, reason: 'none' }, dmarc: { ok: true } }).allowed
    ).toBe(false)
  })

  it('does not block a Microsoft 365 mailbox for a missing DKIM selector', () => {
    // Microsoft signs outbound mail with the tenant key whether or not a custom
    // selector exists, so with SPF passing the mail authenticates. Blocking it
    // was the app inventing a problem — and it cost a real operator a morning
    // publishing DNS records that delivery did not require.
    const v = maySend(
      { spf: { ok: true }, dkim: { ok: false, reason: 'none' }, dmarc: { ok: true } },
      { providerSignsDkim: true }
    )
    expect(v.allowed).toBe(true)
    expect(v.blockers).toEqual([])
    // Still worth doing, so it is said — as a warning, which is what an
    // improvement looks like, rather than a blocker, which is what an
    // impossibility looks like.
    expect(v.warnings.join(' ')).toMatch(/aligns DKIM with your own domain/)
  })

  it('still blocks a missing SPF even when the provider signs', () => {
    // SPF is about whether the sender is entitled to send at all. No signature
    // rescues that.
    const v = maySend(
      { spf: { ok: false, reason: 'no record' }, dkim: { ok: false }, dmarc: { ok: true } },
      { providerSignsDkim: true }
    )
    expect(v.allowed).toBe(false)
    expect(v.blockers).toEqual(['no record'])
  })

  it('reports a missing DMARC as a warning rather than silence', () => {
    const v = maySend({ spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: false } })
    expect(v.allowed).toBe(true)
    expect(v.warnings.length).toBe(1)
  })
})

describe('html and tracking links', () => {
  it('escapes body text and linkifies URLs', () => {
    const html = textToHtml('Hi <you>\n\nSee https://example.test for more')
    expect(html).toContain('&lt;you&gt;')
    expect(html).toContain('href="https://example.test"')
    expect(html).toContain('<p')
  })

  it('appends an unsubscribe footer when given a URL', () => {
    const html = textToHtml('Hello', 'https://app.test/e/u/abc/sig')
    expect(html).toContain('Unsubscribe')
    expect(html).toContain('https://app.test/e/u/abc/sig')
  })

  it('signs and verifies tokens, and rejects tampering', () => {
    const token = signToken('o:msg123')
    expect(verifyToken('o:msg123', token)).toBe(true)
    expect(verifyToken('o:msg124', token)).toBe(false)
    expect(verifyToken('o:msg123', 'x'.repeat(token.length))).toBe(false)
  })

  it('rewrites links for click tracking but never the unsubscribe link', () => {
    const unsub = 'https://app.test/e/u/msg1/sig'
    const html = `<a href="https://example.test/pricing">Pricing</a><a href="${unsub}">Unsubscribe</a>`
    const out = rewriteLinksForTracking(html, 'msg1')
    expect(out).toContain('/e/c/msg1/')
    expect(out).toContain(`href="${unsub}"`)
  })

  it('produces click URLs whose signature covers the destination', () => {
    const url = clickUrl('msg1', 'https://example.test/a')
    const token = url.split('/e/c/msg1/')[1].split('?')[0]
    const encoded = new URL(url).searchParams.get('u')!
    expect(verifyToken(`c:msg1:${encoded}`, token)).toBe(true)
    // Swapping the destination must invalidate the signature — otherwise this is
    // an open redirect.
    const other = Buffer.from('https://evil.test', 'utf8').toString('base64url')
    expect(verifyToken(`c:msg1:${other}`, token)).toBe(false)
  })
})
