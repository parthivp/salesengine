import * as cheerio from 'cheerio'
import type { CheerioAPI, Cheerio } from 'cheerio'
import type { Element } from 'domhandler'

/**
 * Reads a Sales Navigator page you saved yourself and pulls the lead data out of it.
 *
 * The premise, and its limits, are worth stating before the code.
 *
 * Nothing here touches linkedin.com. You open a page in your own browser, save it,
 * and hand the file to this parser — so there is no request pattern for LinkedIn to
 * observe and no automation attached to your account. That is the whole reason this
 * approach is acceptable where a browser extension was not. It does not make the
 * data yours: LinkedIn's user agreement prohibits copying and storing it however
 * manually you do the copying, which is a real consideration if this ever ships to
 * anyone but you.
 *
 * **Every field is extracted through layers, and every field records which layer
 * answered.** Sales Navigator marks its own markup with `data-anonymize` attributes
 * — `person-name`, `job-title`, `company-name`, `location` — which exist so LinkedIn
 * can blur a screenshot for a demo. They are semantic rather than presentational,
 * which makes them an order of magnitude more durable than the hashed class names
 * beside them (`_bodyText_1e5nen`, regenerated on every build). So: attributes
 * first, then document structure, then visible text, then give up and say so. The
 * `source` recorded against each value tells you, later, which fields are resting on
 * something fragile.
 *
 * **Nothing is guessed.** A field the parser cannot find is null and is listed in
 * `missing`. A silently-empty title is far worse than a visible gap, because a gap
 * gets fixed on the review screen and a wrong value gets imported.
 */

// ---------------------------------------------------------------------------

/** Which layer produced a value — the honest measure of how durable it is. */
export type Source =
  /** A `data-anonymize` / `data-x--*` attribute. Semantic; changes rarely. */
  | 'attribute'
  /** Position in the document relative to something anchored. Moderately durable. */
  | 'structure'
  /** Matched against visible text or an icon path. Fragile; last resort. */
  | 'text'

export type ParsedLead = {
  /** The opaque Sales Navigator lead id, from the profile link. */
  leadId: string | null
  /** A URL that opens this person, for the queue's "open profile" button. */
  leadUrl: string | null
  fullName: string | null
  firstName: string | null
  lastName: string | null
  /**
   * True when LinkedIn showed the surname as an initial — "Jarno H." — which it
   * does for people outside your network. The name is not wrong, it is withheld,
   * and importing "H." as a surname would be worse than importing nothing.
   */
  nameTruncated: boolean
  headline: string | null
  title: string | null
  companyName: string | null
  /** Sales Navigator's own company id, a stable join key if we ever need one. */
  companyId: string | null
  /** From the lead's own contact links. Present on a minority of profiles. */
  companyDomain: string | null
  location: string | null
  /** '1st' | '2nd' | '3rd' — how far they are from you. */
  degree: string | null
  /** The "About" text, useful to a human reviewing the row. Never used in drafts. */
  blurb: string | null
  /** An address the person published in their own bio. Usually a company inbox. */
  emailInBio: string | null
  /** Which layer answered, per field that was found. */
  found: Partial<Record<keyof ParsedLead, Source>>
  /** Fields this parser looks for and could not find on this page. */
  missing: string[]
}

export type ParsedPage = {
  kind: 'lead' | 'search' | 'unknown'
  /** From the comment Chrome writes when you "Save page as". Absent on a paste. */
  sourceUrl: string | null
  leads: ParsedLead[]
  /** Things the operator should know before trusting the rows. */
  warnings: string[]
}

/** The fields worth reporting a hit rate on. Excludes derived and bookkeeping ones. */
export const REPORTED_FIELDS = [
  'fullName', 'firstName', 'lastName', 'headline', 'title', 'companyName',
  'companyId', 'companyDomain', 'location', 'leadUrl', 'degree', 'blurb',
] as const

// ---------------------------------------------------------------------------

const clean = (s: string | undefined | null): string | null => {
  if (!s) return null
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length ? t : null
}

/** The map-pin icon Sales Navigator puts beside a location. */
const PIN_PATH = 'M8 1a5 5 0 00-4.36 7.45'

export function parseSalesNavigator(html: string): ParsedPage {
  const $ = cheerio.load(html)
  const warnings: string[] = []

  const sourceUrl = clean(/saved from url=\(\d+\)(\S+)/.exec(html)?.[1] ?? null)

  // Search results are checked *first*, and this ordering is load-bearing. Clicking
  // a result opens that person in a panel over the list, and the panel carries the
  // same <h1> a full lead page has — so a page saved in that state looks like both.
  // Reading it as a lead page silently discards the other people on it, which is
  // the exact state a list is most likely to be saved in.
  const rows = $('li.artdeco-list__item').filter((_, el) =>
    $(el).find('a[href*="/sales/lead/"]').length > 0
  )
  if (rows.length) {
    const leads: ParsedLead[] = []
    rows.each((_, el) => {
      const lead = parseSearchRow($, $(el))
      if (lead.fullName || lead.leadId) leads.push(lead)
    })

    // The results list is virtualised: rows scroll out of the DOM as well as into
    // it, so a saved page holds what was on screen, not the 25 the page claims.
    // Saying so is the difference between "the parser missed 19 people" and "scroll
    // to the bottom before saving".
    warnings.push(
      `Found ${leads.length} ${leads.length === 1 ? 'person' : 'people'} on this page. ` +
        'Sales Navigator drops rows from the page as they scroll out of view, so scroll ' +
        'the whole list before saving if you want all 25.'
    )
    return { kind: 'search', sourceUrl, leads, warnings }
  }

  const h1 = $('h1[data-anonymize="person-name"], h1[data-x--lead--name]').first()
  if (h1.length) {
    const lead = parseLeadPage($, h1, sourceUrl)
    return { kind: 'lead', sourceUrl, leads: [lead], warnings }
  }

  return {
    kind: 'unknown',
    sourceUrl,
    leads: [],
    warnings: [
      'This does not look like a Sales Navigator lead or search page. Save the page ' +
        'from the browser (Ctrl+S, “Webpage, Complete”) rather than copying the text.',
    ],
  }
}

// ---------------------------------------------------------------------------
// Lead detail page
// ---------------------------------------------------------------------------

function parseLeadPage($: CheerioAPI, h1: Cheerio<Element>, sourceUrl: string | null): ParsedLead {
  const out = blank()
  const set = <K extends keyof ParsedLead>(k: K, v: ParsedLead[K], source: Source) => {
    if (v === null || v === undefined || v === '') return
    out[k] = v
    out.found[k] = source
  }

  set('fullName', clean(h1.text()), 'attribute')
  applyName(out)

  // The lead id is in the page's own URL, and that is the only place it is
  // guaranteed to be — the page does not link to itself.
  const id = /\/sales\/lead\/([^,?"#\s]+)/.exec(sourceUrl ?? '')?.[1] ?? null
  if (id) {
    set('leadId', id, 'structure')
    set('leadUrl', `https://www.linkedin.com/sales/lead/${id}`, 'structure')
  }

  set('headline', clean($('span[data-anonymize="headline"]').first().text()), 'attribute')

  // Current role: the first "current role" line, which pairs a title with a company
  // and, when the company has a Sales Navigator page, a link carrying its id.
  const role = $('[class*="_current-role-item_"]').first()
  if (role.length) {
    set('title', clean(role.find('[data-anonymize="job-title"]').first().text()), 'attribute')
    const company = role.find('[data-anonymize="company-name"]').first()
    set('companyName', clean(company.text()), 'attribute')
    set('companyId', companyIdFrom(company.attr('href') ?? company.attr('data-entity-hovercard-id')), 'attribute')
  } else {
    // Some profiles show the role only in the experience list.
    const exp = $('h2[data-anonymize="job-title"]').first()
    set('title', clean(exp.text()), 'attribute')
    set('companyName', clean($('p[data-anonymize="company-name"]').first().text()), 'structure')
  }

  // Location carries no attribute of its own. It is the line next to the map pin,
  // in the block of meta lines under the headline. Matching the icon's path data is
  // ugly but it is what identifies the line — the alternative is counting siblings,
  // which breaks the first time LinkedIn adds a row.
  const pin = $(`svg path[d^="${PIN_PATH}"]`).first().closest('div')
  if (pin.length) {
    set('location', clean(pin.text()), 'text')
  } else {
    const meta = $('span[data-anonymize="headline"]').first().parent().next().children()
    const guess = meta
      .toArray()
      .map((el) => clean($(el).text()))
      .find((t) => t && !/connections?$|followers?$/i.test(t))
    set('location', guess ?? null, 'structure')
  }

  const degree = $('[class*="_name-sublabel"]').first().text()
  set('degree', clean(/(1st|2nd|3rd)/.exec(degree)?.[1] ?? null), 'structure')

  // The person's own website link, which is the company domain far more often than
  // not — and companyDomain is the stronger of the two ways we match an account.
  //
  // Anchored on the link's screen-reader label ("CHENG’s website"), not on "the
  // first external link on the page". That shortcut passed the fixtures by
  // accident: every profile also carries a Bing search link, so it reported a
  // domain of bing.com for everyone who had no website at all — a wrong value
  // masquerading as a 100% hit rate.
  const site = $('a[href^="http"]')
    .filter((_, el) => /\bwebsite\b/i.test($(el).find('.a11y-text').text()))
    .first()
    .attr('href')
  set('companyDomain', domainFrom(site), 'structure')

  const blurb = clean($('[data-anonymize="person-blurb"]').first().text())
  set('blurb', blurb, 'attribute')
  set('emailInBio', emailFrom(blurb), 'text')

  finish(out)
  return out
}

// ---------------------------------------------------------------------------
// Search results row
// ---------------------------------------------------------------------------

function parseSearchRow($: CheerioAPI, row: Cheerio<Element>): ParsedLead {
  const out = blank()
  const set = <K extends keyof ParsedLead>(k: K, v: ParsedLead[K], source: Source) => {
    if (v === null || v === undefined || v === '') return
    out[k] = v
    out.found[k] = source
  }

  const href = row.find('a[href*="/sales/lead/"]').first().attr('href') ?? ''
  const id = /\/sales\/lead\/([^,?"#\s]+)/.exec(href)?.[1] ?? null
  if (id) {
    set('leadId', id, 'attribute')
    set('leadUrl', `https://www.linkedin.com/sales/lead/${id}`, 'attribute')
  }

  set('fullName', clean(row.find('[data-anonymize="person-name"]').first().text()), 'attribute')
  applyName(out)

  // On a results row the current title wears `title`, not `job-title` — `job-title`
  // holds the tenure line ("1 year 11 months in role"). Reusing the same reader for
  // both page types would have quietly imported that as everyone's job title.
  set('title', clean(row.find('[data-anonymize="title"]').first().text()), 'attribute')

  // Company, in three tries. The attribute is only present when the company has a
  // Sales Navigator page of its own; a small firm without one appears as a bare
  // text node beside the title, and reading only the attribute drops exactly the
  // small companies a solo founder is most likely to be selling to.
  const company = row.find('[data-anonymize="company-name"]').first()
  if (company.length) {
    set('companyName', clean(company.text()), 'attribute')
    set('companyId', companyIdFrom(company.attr('href') ?? company.attr('data-entity-hovercard-id')), 'attribute')
  } else {
    const label = row.find('button[aria-label^="See more about "]').first().attr('aria-label')
    if (label) {
      set('companyName', clean(label.replace(/^See more about\s+/i, '')), 'attribute')
    } else {
      // Last resort: whatever follows the title in the subtitle line.
      const subtitle = row.find('[data-anonymize="title"]').first().parent()
      const tail = clean(subtitle.text()?.replace(clean(row.find('[data-anonymize="title"]').first().text()) ?? '', ''))
      set('companyName', tail, 'structure')
    }
  }

  set('location', clean(row.find('[data-anonymize="location"]').first().text()), 'attribute')

  const blurb = clean(row.find('[data-anonymize="person-blurb"]').first().text())
  set('blurb', blurb?.replace(/\s*…?\s*Show more$/i, '') ?? null, 'attribute')
  set('emailInBio', emailFrom(blurb), 'text')

  const degree = row.text()
  set('degree', clean(/\b(1st|2nd|3rd)\b/.exec(degree)?.[1] ?? null), 'text')

  finish(out)
  return out
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function blank(): ParsedLead {
  return {
    leadId: null, leadUrl: null, fullName: null, firstName: null, lastName: null,
    nameTruncated: false, headline: null, title: null, companyName: null,
    companyId: null, companyDomain: null, location: null, degree: null,
    blurb: null, emailInBio: null, found: {}, missing: [],
  }
}

/**
 * Splits a display name, and refuses to invent a surname.
 *
 * LinkedIn abbreviates the surname of anyone outside your network — "Jarno H." —
 * so the last name is withheld rather than absent. Recording "H." as a surname puts
 * a wrong value in the record and, worse, into the greeting of a message.
 */
function applyName(out: ParsedLead): void {
  const full = out.fullName
  if (!full) return

  // Credentials are not surnames. "Michael Haukaas, Ph.D." and "Quincy Newell,
  // Esq." both put a qualification where the last word is, and taking the last
  // word wrote "Ph.D." into the surname field — which then appears in a merge tag
  // in a message. Anything after a comma is dropped, and a known suffix is dropped
  // wherever it appears.
  const withoutCreds = full.split(',')[0]
  const parts = withoutCreds
    .split(/\s+/)
    .filter(Boolean)
    .filter((p) => !SUFFIXES.has(p.replace(/\./g, '').toLowerCase()))

  out.firstName = parts[0] ?? null
  if (out.firstName) out.found.firstName = out.found.fullName

  const last = parts.length > 1 ? parts[parts.length - 1] : null
  if (!last) return

  // "Jarno H." — LinkedIn withholds the surname of anyone outside your network.
  // A single initial is not a name, and recording it as one is worse than a gap.
  if (/^[A-Z]\.?$/.test(last)) {
    out.nameTruncated = true
    return
  }
  out.lastName = last
  out.found.lastName = out.found.fullName
}

const SUFFIXES = new Set([
  'phd', 'md', 'jd', 'esq', 'mba', 'cpa', 'cfa', 'pe', 'rn', 'dds', 'dvm',
  'jr', 'sr', 'ii', 'iii', 'iv', 'msc', 'ma', 'ms', 'bsc', 'ba', 'pmp',
])

function companyIdFrom(raw: string | undefined): string | null {
  if (!raw) return null
  return /(?:\/sales\/company\/|fs_salesCompany:)(\d+)/.exec(raw)?.[1] ?? null
}

function domainFrom(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function emailFrom(text: string | null): string | null {
  if (!text) return null
  return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0]?.toLowerCase() ?? null
}

function finish(out: ParsedLead): void {
  out.missing = REPORTED_FIELDS.filter((f) => out[f] === null)
}
