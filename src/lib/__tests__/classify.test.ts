import { describe, it, expect } from 'vitest'
import {
  classifyReply,
  stripQuoted,
  parseReturnDate,
  REVIEW_THRESHOLD,
  type ReplyInput,
} from '../email/classify'

const NOW = new Date('2026-07-30T09:00:00Z')

function reply(over: Partial<ReplyInput> = {}): ReplyInput {
  return { subject: 'Re: Quick question', bodyText: 'Sure, sounds good.', fromEmail: 'buyer@prospect.test', ...over }
}

describe('out of office', () => {
  it('does not stop the sequence — the whole reason this module exists', () => {
    // A vacation responder ending a sequence loses the prospect for two weeks and
    // does it silently. This is the single assertion that matters most here.
    const c = classifyReply(
      reply({ subject: 'Automatic reply: Quick question', bodyText: 'I am out of the office until 14 August.' }),
      NOW
    )
    expect(c.intent).toBe('out_of_office')
    expect(c.stopsSequence).toBe(false)
    expect(c.suppresses).toBe(false)
  })

  it('trusts the RFC 3834 header over the prose', () => {
    // No English cue at all — a Finnish vacation responder. The header is the only
    // reliable signal, and it is a statement of fact by the sending system.
    const c = classifyReply(
      reply({
        subject: 'Vastaus: Quick question',
        bodyText: 'Olen lomalla ja palaan 14. elokuuta.',
        headers: { 'Auto-Submitted': 'auto-replied' },
      }),
      NOW
    )
    expect(c.stopsSequence).toBe(false)
    expect(['auto_reply', 'out_of_office']).toContain(c.intent)
    expect(c.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD)
  })

  it.each([
    ['Auto-Submitted', { 'Auto-Submitted': 'auto-generated' }],
    ['X-Autoreply', { 'X-Autoreply': 'yes' }],
    ['Precedence', { Precedence: 'auto_reply' }],
    ['Exchange loop', { 'X-MS-Exchange-Inbox-Rules-Loop': 'x@y.test' }],
    ['null Return-Path', { 'Return-Path': '<>' }],
  ])('detects machine mail from the %s header', (_label, headers) => {
    const c = classifyReply(reply({ bodyText: 'Thanks for your message.', headers }), NOW)
    expect(c.stopsSequence).toBe(false)
  })

  it('is case-insensitive about header names', () => {
    const c = classifyReply(reply({ bodyText: 'x', headers: { 'AUTO-SUBMITTED': 'auto-replied' } }), NOW)
    expect(c.stopsSequence).toBe(false)
  })

  it.each([
    'I am currently out of the office with limited access to email.',
    "I'm on annual leave and will be back on 12 September.",
    'I am travelling and returning to the office next week.',
    'Away from my desk until Monday.',
  ])('recognises the phrasing: %s', (bodyText) => {
    expect(classifyReply(reply({ subject: 'Re: hello', bodyText }), NOW).intent).toBe('out_of_office')
  })

  it('does not mistake a real reply mentioning a holiday for an absence notice', () => {
    // "I was out of office last week" is a person writing to you, not a responder.
    const c = classifyReply(
      reply({
        subject: 'Re: Quick question',
        bodyText: 'Sorry for the delay, I was away last week. Happy to chat — send me some times.',
      }),
      NOW
    )
    expect(c.intent).toBe('interested')
    expect(c.stopsSequence).toBe(true)
  })
})

describe('return dates', () => {
  it.each([
    ['back on 14 August', '2026-08-14'],
    ['returning on August 14', '2026-08-14'],
    ['I will be back on 3rd September', '2026-09-03'],
    ['out until 2026-08-20', '2026-08-20'],
  ])('parses %s', (text, expected) => {
    expect(parseReturnDate(text, NOW)?.toISOString().slice(0, 10)).toBe(expected)
  })

  it('rolls into next year when the date has already passed', () => {
    // A responder in December saying "back on 4 January" means January next year.
    const dec = new Date('2026-12-20T09:00:00Z')
    expect(parseReturnDate('back on 4 January', dec)?.toISOString().slice(0, 10)).toBe('2027-01-04')
  })

  it('returns null rather than guessing', () => {
    // A wrong date silently delays a live prospect by weeks, so no answer beats a
    // plausible wrong one.
    for (const text of ['back soon', 'I am away', 'returning shortly', 'back on the 32nd of Marchtember']) {
      expect(parseReturnDate(text, NOW), text).toBeNull()
    }
  })

  it('rejects an impossible calendar date instead of rolling it over', () => {
    // new Date(2026, 1, 31) silently becomes 3 March.
    expect(parseReturnDate('back on 31 February', NOW)).toBeNull()
  })

  it('rejects a date absurdly far out', () => {
    const c = classifyReply(
      reply({ subject: 'Automatic reply', bodyText: 'Out of office, back on 14 August 2099.' }),
      NOW
    )
    // Either no date, or one inside the sane window — never the year 2099.
    if (c.returnsAt) expect(c.returnsAt.getTime() - NOW.getTime()).toBeLessThan(366 * 86_400_000)
  })
})

describe('opt-out', () => {
  it.each([
    'Please unsubscribe me.',
    'Take me off your list.',
    'Remove me from this mailing.',
    'Do not email me again.',
    'Please stop emailing me.',
  ])('treats "%s" as an opt-out that suppresses', (bodyText) => {
    const c = classifyReply(reply({ bodyText }), NOW)
    expect(c.intent).toBe('unsubscribe')
    expect(c.suppresses).toBe(true)
    expect(c.stopsSequence).toBe(true)
  })

  it('treats a GDPR erasure request as an opt-out', () => {
    const c = classifyReply(reply({ bodyText: 'Under GDPR I request the right to erasure of my data.' }), NOW)
    expect(c.suppresses).toBe(true)
  })

  it('beats an out-of-office in the same message', () => {
    // "I'm away — and take me off your list" must suppress. Checking the absence
    // notice first would drop the opt-out on the floor, which is a legal problem
    // rather than a conversion one.
    const c = classifyReply(
      reply({
        subject: 'Automatic reply: Quick question',
        bodyText: 'I am out of the office until 14 August. Also please take me off your list.',
        headers: { 'Auto-Submitted': 'auto-replied' },
      }),
      NOW
    )
    expect(c.intent).toBe('unsubscribe')
    expect(c.suppresses).toBe(true)
  })
})

describe('bounces', () => {
  it('reads a delivery-status report from its content type', () => {
    const c = classifyReply(
      reply({
        subject: 'Undeliverable: Quick question',
        headers: { 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' },
      }),
      NOW
    )
    expect(c.intent).toBe('bounce')
  })

  it.each(['Undeliverable: Quick question', 'Mail delivery failed: returning message to sender', 'Delivery Status Notification (Failure)'])(
    'recognises the subject: %s',
    (subject) => {
      expect(classifyReply(reply({ subject, bodyText: '' }), NOW).intent).toBe('bounce')
    }
  )
})

describe('human intent', () => {
  it.each([
    'Yes, interested — can you send pricing?',
    "Sounds good, let's set up a call.",
    'Tell me more.',
    'What does it cost?',
    'Happy to chat next week.',
  ])('reads "%s" as interested', (bodyText) => {
    const c = classifyReply(reply({ bodyText }), NOW)
    expect(c.intent).toBe('interested')
    expect(c.stopsSequence).toBe(true)
  })

  it.each([
    'Not interested, thanks.',
    'No thanks, we are all set.',
    'Not a fit for us right now.',
    'We already have a tool for this.',
  ])('reads "%s" as not interested', (bodyText) => {
    expect(classifyReply(reply({ bodyText }), NOW).intent).toBe('not_interested')
  })

  it.each([
    'Wrong person — you want to speak to Ana in Ops.',
    'I do not handle this, reaching out to Priya instead.',
    'John has left the company, please contact Sam.',
  ])('reads "%s" as the wrong person', (bodyText) => {
    const c = classifyReply(reply({ bodyText }), NOW)
    expect(c.intent).toBe('wrong_person')
    expect(c.stopsSequence).toBe(true)
  })

  it.each([
    'Not right now, but send me pricing for next quarter.',
    'No bandwidth this quarter — circle back in January and send a deck.',
    'Try me again in Q4, happy to chat then.',
  ])('routes the deferral "%s" to a human rather than calling it interest', (bodyText) => {
    // A deferral that also asks for something reads as pure interest to a naive
    // pattern, so it gets filed as "reply today" and a rep calls someone who just
    // said not yet. Both readings are present; a person should pick.
    const c = classifyReply(reply({ bodyText }), NOW)
    expect(c.intent).not.toBe('interested')
    expect(c.needsReview || c.intent === 'not_interested').toBe(true)
  })

  it('asks a human when the message conflicts with itself', () => {
    // "Not right now, but send pricing for Q4" is genuinely ambiguous, and acting
    // on either reading alone is expensive.
    const c = classifyReply(
      reply({ bodyText: 'Not interested at this time, but send me pricing for next quarter.' }),
      NOW
    )
    expect(c.intent).toBe('unclear')
    expect(c.needsReview).toBe(true)
    expect(c.stopsSequence).toBe(true)
  })

  it('asks a human when a person replies with nothing recognisable', () => {
    const c = classifyReply(reply({ bodyText: 'ok' }), NOW)
    expect(c.intent).toBe('unclear')
    expect(c.needsReview).toBe(true)
    // Still stops: they are in a conversation with you now.
    expect(c.stopsSequence).toBe(true)
  })

  it('always stops the sequence when a person replied, whatever they said', () => {
    for (const bodyText of ['Yes please', 'No thanks', 'Wrong person, ask Ana', 'huh?']) {
      expect(classifyReply(reply({ bodyText }), NOW).stopsSequence, bodyText).toBe(true)
    }
  })

  it('gives every decision a stated reason', () => {
    for (const bodyText of ['Yes please', 'unsubscribe', 'I am out of the office', 'ok']) {
      expect(classifyReply(reply({ bodyText }), NOW).reasons.length, bodyText).toBeGreaterThan(0)
    }
  })
})

describe('quoted history', () => {
  it('reads only what this person wrote', () => {
    // Without stripping, our own email is in every reply — so "interested" matches
    // our own copy and every reply looks positive.
    const body = [
      'Not interested, thanks.',
      '',
      'On Wed, 29 Jul 2026 at 10:12, Parthiv <p@acme.test> wrote:',
      '> Hi — happy to chat, let me know if you are interested and I can send pricing.',
    ].join('\n')
    expect(stripQuoted(body)).toBe('Not interested, thanks.')
    expect(classifyReply(reply({ bodyText: body }), NOW).intent).toBe('not_interested')
  })

  it.each([
    ['angle quotes', '> quoted'],
    ['Outlook separator', '-----Original Message-----'],
    ['forwarded block', '---------- Forwarded message ----------'],
    ['underscore rule', '________________________________'],
  ])('cuts at the %s marker', (_label, marker) => {
    const stripped = stripQuoted(`My actual reply.\n\n${marker}\nOld thread with the word interested in it.`)
    expect(stripped).toBe('My actual reply.')
  })

  it('drops a mobile signature without dropping the message', () => {
    expect(stripQuoted('No thanks.\nSent from my iPhone')).toBe('No thanks.')
  })

  it('survives an empty body', () => {
    expect(stripQuoted('')).toBe('')
    expect(classifyReply(reply({ bodyText: '' }), NOW).needsReview).toBe(true)
  })
})

describe('no-reply senders', () => {
  it.each(['no-reply@x.test', 'noreply@x.test', 'donotreply@x.test', 'mailer-daemon@x.test', 'postmaster@x.test'])(
    'does not treat %s as a person replying',
    (fromEmail) => {
      const c = classifyReply(reply({ fromEmail, bodyText: 'Your ticket has been received.' }), NOW)
      expect(c.stopsSequence).toBe(false)
    }
  )

  it('does not catch a real person whose address merely starts similarly', () => {
    const c = classifyReply(reply({ fromEmail: 'noreen@prospect.test', bodyText: 'Yes, interested!' }), NOW)
    expect(c.intent).toBe('interested')
  })
})
