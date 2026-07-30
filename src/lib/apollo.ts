import { env } from './env'
import { logger } from './logger'

/**
 * Apollo.io adapter.
 *
 * Everything here degrades gracefully when APOLLO_API_KEY is unset: the app
 * must remain fully usable on CSV imports and form capture alone, so a missing
 * key is a disabled feature, not a crash.
 *
 * Credits are real money, so:
 *   - `enrich` is only ever called explicitly or by a scheduled job, never on
 *     page render;
 *   - bulk endpoints are used wherever they exist (10 people per call);
 *   - results are persisted with `enrichedAt` so we can skip fresh records.
 */

const BASE = 'https://api.apollo.io/api/v1'
const STALE_AFTER_DAYS = 90

export class ApolloNotConfiguredError extends Error {
  constructor() {
    super('Apollo is not configured. Add APOLLO_API_KEY to enable enrichment.')
    this.name = 'ApolloNotConfiguredError'
  }
}

export function apolloEnabled(): boolean {
  return Boolean(env.APOLLO_API_KEY)
}

export function isStale(enrichedAt: Date | null | undefined): boolean {
  if (!enrichedAt) return true
  return Date.now() - enrichedAt.getTime() > STALE_AFTER_DAYS * 86_400_000
}

async function call<T>(path: string, body: unknown, attempt = 1): Promise<T> {
  if (!env.APOLLO_API_KEY) throw new ApolloNotConfiguredError()

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  })

  // 429 and 5xx are worth retrying; 4xx are not.
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) {
      throw new Error(`Apollo ${path} failed after ${attempt} attempts (${res.status})`)
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt
    logger.warn({ path, status: res.status, retryAfter }, 'Apollo rate-limited; backing off')
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return call<T>(path, body, attempt + 1)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Apollo ${path} returned ${res.status}: ${text.slice(0, 300)}`)
  }

  return (await res.json()) as T
}

// --- shapes we actually consume --------------------------------------------

export type ApolloPerson = {
  id: string
  first_name?: string
  last_name?: string
  name?: string
  title?: string
  email?: string
  email_status?: string
  linkedin_url?: string
  city?: string
  country?: string
  organization?: {
    id?: string
    name?: string
    website_url?: string
    primary_domain?: string
    industry?: string
    estimated_num_employees?: number
    annual_revenue?: number
    linkedin_url?: string
    city?: string
    country?: string
  }
}

export type ApolloOrganization = {
  id: string
  name?: string
  website_url?: string
  primary_domain?: string
  industry?: string
  estimated_num_employees?: number
  annual_revenue?: number
  linkedin_url?: string
  city?: string
  country?: string
  short_description?: string
}

export type PeopleSearchParams = {
  titles?: string[]
  seniorities?: string[]
  locations?: string[]
  employeeRanges?: string[]
  industries?: string[]
  domains?: string[]
  keywords?: string
  page?: number
  perPage?: number
}

export type PeopleSearchResult = {
  people: ApolloPerson[]
  page: number
  perPage: number
  total: number
}

export async function searchPeople(params: PeopleSearchParams): Promise<PeopleSearchResult> {
  const body: Record<string, unknown> = {
    page: params.page ?? 1,
    per_page: Math.min(params.perPage ?? 25, 100),
  }
  if (params.titles?.length) body.person_titles = params.titles
  if (params.seniorities?.length) body.person_seniorities = params.seniorities
  if (params.locations?.length) body.person_locations = params.locations
  if (params.employeeRanges?.length) body.organization_num_employees_ranges = params.employeeRanges
  if (params.industries?.length) body.q_organization_keyword_tags = params.industries
  if (params.domains?.length) body.q_organization_domains_list = params.domains
  if (params.keywords) body.q_keywords = params.keywords

  const json = await call<{
    people?: ApolloPerson[]
    contacts?: ApolloPerson[]
    pagination?: { page: number; per_page: number; total_entries: number }
  }>('/mixed_people/search', body)

  return {
    people: [...(json.people ?? []), ...(json.contacts ?? [])],
    page: json.pagination?.page ?? 1,
    perPage: json.pagination?.per_page ?? 25,
    total: json.pagination?.total_entries ?? 0,
  }
}

/** Single-person enrichment. Prefer `bulkEnrichPeople` — same credits, fewer calls. */
export async function enrichPerson(input: {
  email?: string
  firstName?: string
  lastName?: string
  domain?: string
  linkedinUrl?: string
}): Promise<ApolloPerson | null> {
  const json = await call<{ person?: ApolloPerson }>('/people/match', {
    email: input.email,
    first_name: input.firstName,
    last_name: input.lastName,
    domain: input.domain,
    linkedin_url: input.linkedinUrl,
    reveal_personal_emails: false,
  })
  return json.person ?? null
}

/** Apollo caps bulk match at 10 records per request. */
export async function bulkEnrichPeople(
  details: { email?: string; firstName?: string; lastName?: string; domain?: string; linkedinUrl?: string }[]
): Promise<(ApolloPerson | null)[]> {
  const out: (ApolloPerson | null)[] = []
  for (let i = 0; i < details.length; i += 10) {
    const chunk = details.slice(i, i + 10)
    const json = await call<{ matches?: (ApolloPerson | null)[] }>('/people/bulk_match', {
      details: chunk.map((d) => ({
        email: d.email,
        first_name: d.firstName,
        last_name: d.lastName,
        domain: d.domain,
        linkedin_url: d.linkedinUrl,
      })),
      reveal_personal_emails: false,
    })
    out.push(...(json.matches ?? chunk.map(() => null)))
  }
  return out
}

export async function enrichOrganization(domain: string): Promise<ApolloOrganization | null> {
  const json = await call<{ organization?: ApolloOrganization }>('/organizations/enrich', { domain })
  return json.organization ?? null
}

// --- mapping into our schema ------------------------------------------------

export function personToContactFields(p: ApolloPerson) {
  const emailStatus =
    p.email_status === 'verified' ? 'valid'
    : p.email_status === 'guessed' ? 'risky'
    : p.email_status === 'unavailable' ? 'invalid'
    : 'unverified'

  return {
    apolloId: p.id,
    firstName: p.first_name ?? p.name?.split(' ')[0],
    lastName: p.last_name ?? (p.name?.split(' ').slice(1).join(' ') || undefined),
    title: p.title,
    email: p.email?.toLowerCase(),
    emailStatus: emailStatus as 'valid' | 'risky' | 'invalid' | 'unverified',
    linkedinUrl: p.linkedin_url,
    city: p.city,
    country: p.country,
    enrichedAt: new Date(),
  }
}

export function organizationToAccountFields(o: ApolloOrganization) {
  return {
    apolloId: o.id,
    name: o.name,
    domain: o.primary_domain?.toLowerCase(),
    industry: o.industry,
    employeeCount: o.estimated_num_employees,
    annualRevenue: o.annual_revenue != null ? BigInt(Math.round(o.annual_revenue)) : undefined,
    linkedinUrl: o.linkedin_url,
    websiteUrl: o.website_url,
    city: o.city,
    country: o.country,
    description: o.short_description,
    enrichedAt: new Date(),
  }
}

export const SENIORITIES = [
  'owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director',
  'manager', 'senior', 'entry', 'intern',
] as const

export const EMPLOYEE_RANGES = [
  '1,10', '11,20', '21,50', '51,100', '101,200', '201,500',
  '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001,',
] as const
