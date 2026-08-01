import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSalesNavigator, type ParsedLead } from '../linkedin/parse-salesnav'

/**
 * The parser, against real saved pages.
 *
 * Fixtures rather than hand-written HTML, deliberately. A parser tested against
 * markup I wrote myself only proves I can read my own selectors; the thing that
 * actually breaks is LinkedIn changing a page, and only a real page can catch that.
 *
 * When something does break, the failing test names the field, so the repair is
 * "save a fresh page into fixtures/ and fix one selector" rather than an evening of
 * re-reading the DOM.
 *
 * The fixtures hold eight real people's names, titles and companies. If that is not
 * something to keep in the repository, delete `fixtures/salesnav/` — these tests
 * skip when it is absent rather than failing.
 */

const DIR = join(process.cwd(), 'fixtures', 'salesnav')
const has = (f: string) => existsSync(join(DIR, f))
const load = (f: string) => parseSalesNavigator(readFileSync(join(DIR, f), 'utf8'))
const by = (leads: ParsedLead[], name: string) =>
  leads.find((l) => l.fullName?.startsWith(name))

describe.skipIf(!has('lead-cheng-huang.html'))('a saved lead page', () => {
  const page = () => load('lead-cheng-huang.html')

  it('is recognised as a lead page', () => {
    expect(page().kind).toBe('lead')
    expect(page().leads).toHaveLength(1)
  })

  it('reads the name, headline, title and company', () => {
    const l = page().leads[0]
    expect(l.fullName).toBe('CHENG HUANG')
    expect(l.firstName).toBe('CHENG')
    expect(l.lastName).toBe('HUANG')
    expect(l.headline).toContain('AI-Native Founder')
    expect(l.title).toBe('Founder & Builder')
    expect(l.companyName).toBe('SoloTerminal')
    expect(l.companyId).toBe('133164083')
  })

  it('reads the location, which carries no attribute of its own', () => {
    expect(page().leads[0].location).toBe('Greater Toronto Area, Canada')
  })

  it('takes the profile URL from the page it was saved from', () => {
    const l = page().leads[0]
    expect(l.leadId).toBe('ACwAACGeMVABt-42jjk9y6yLGblh3cauk2caM9s')
    expect(l.leadUrl).toBe(`https://www.linkedin.com/sales/lead/${l.leadId}`)
  })

  it('reads the website link as the company domain', () => {
    expect(page().leads[0].companyDomain).toBe('soloterminal.com')
  })
})

describe.skipIf(!has('lead-angel-taveras.html'))('a lead with no website', () => {
  it('reports no domain rather than the first link on the page', () => {
    // Every profile also carries a Bing search link. An earlier version took "the
    // first external link", which reported bing.com as the company domain for
    // everyone without a website — a wrong value that looked like a perfect score.
    expect(load('lead-angel-taveras.html').leads[0].companyDomain).toBeNull()
  })
})

describe.skipIf(!has('search-results.html'))('a saved results list', () => {
  const page = () => load('search-results.html')

  it('is read as a list even with a lead panel open over it', () => {
    // Clicking a result opens that person in a panel carrying the same <h1> a full
    // lead page has. Treating the page as a lead page would silently discard
    // everyone else on it — and that is the state a list is usually saved in.
    expect(page().kind).toBe('search')
    expect(page().leads.length).toBeGreaterThan(1)
  })

  it('warns that the page holds only the rows that were scrolled through', () => {
    expect(page().warnings.join(' ')).toMatch(/scroll/i)
  })

  it('reads title, company and location off each row', () => {
    const l = by(page().leads, 'Jarno')!
    expect(l.title).toBe('Founder & Investor')
    expect(l.companyName).toBe('Xpometer')
    expect(l.location).toBe('Tamarindo, Guanacaste, Costa Rica')
    expect(l.leadUrl).toContain('/sales/lead/')
  })

  it('does not mistake the tenure line for the job title', () => {
    // On a results row the current title wears `title`; `job-title` holds "7 months
    // in role". Reusing the lead-page reader here imported that as everyone's title.
    for (const l of page().leads) expect(l.title).not.toMatch(/months? in|years? in/i)
  })

  it('finds a company that has no LinkedIn page of its own', () => {
    // Small firms have no company page, so no company-name attribute — they are a
    // bare text node. Reading only the attribute drops exactly the small companies
    // a one-person business is most likely to be selling to.
    const l = by(page().leads, 'Angel')!
    expect(l.companyName).toBe('Taveras Law, P.C.')
    expect(l.companyId).toBeNull()
  })

  it('does not put a credential in the surname', () => {
    expect(by(page().leads, 'Michael')!.lastName).toBe('Haukaas')
    expect(by(page().leads, 'Quincy')!.lastName).toBe('Newell')
  })

  it('leaves the surname empty when LinkedIn withheld it', () => {
    // "Jarno H." — out of network, so the surname is withheld rather than absent.
    // Storing "H." would put it in the greeting of a message.
    const l = by(page().leads, 'Jarno')!
    expect(l.nameTruncated).toBe(true)
    expect(l.lastName).toBeNull()
    expect(l.firstName).toBe('Jarno')
  })

  it('records which layer answered, so fragile fields are visible later', () => {
    const l = by(page().leads, 'CHENG')!
    expect(l.found.fullName).toBe('attribute')
    expect(l.found.companyName).toBe('attribute')
  })

  it('lists what it could not find instead of guessing', () => {
    // A results row has no headline. It must be reported missing, not invented.
    const l = by(page().leads, 'CHENG')!
    expect(l.headline).toBeNull()
    expect(l.missing).toContain('headline')
  })
})

describe('something that is not a Sales Navigator page', () => {
  it('says so rather than returning an empty list', () => {
    const page = parseSalesNavigator('<html><body><h1>Hello</h1></body></html>')
    expect(page.kind).toBe('unknown')
    expect(page.leads).toHaveLength(0)
    expect(page.warnings[0]).toMatch(/Sales Navigator/)
  })
})
