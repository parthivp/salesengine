/**
 * The column vocabulary for the Sales Navigator importer.
 *
 * Split out from `import.ts` for one reason: the import wizard is a client
 * component, and `import.ts` reaches Prisma. Importing it from the browser bundle
 * would drag the database client along with it, so the field list used to be
 * copied into `client.tsx` by hand.
 *
 * That copy drifted. The server understood `companyDomain` and `country`; the
 * wizard offered neither, so every file that carried them had them silently
 * dropped — and a contact with no domain gets matched to an account by name
 * instead, which is the weaker join. This module is the single definition both
 * sides import, so the next field is added once.
 *
 * Nothing here imports anything. Keep it that way.
 */

export const SALESNAV_FIELDS = [
  { key: 'linkedinUrl', label: 'Profile URL', required: true },
  { key: 'firstName', label: 'First name', required: false },
  { key: 'lastName', label: 'Last name', required: false },
  { key: 'title', label: 'Title', required: false },
  { key: 'companyName', label: 'Company', required: false },
  { key: 'companyDomain', label: 'Company domain', required: false },
  { key: 'email', label: 'Email (optional)', required: false },
  { key: 'city', label: 'Location', required: false },
  { key: 'country', label: 'Country', required: false },
] as const

export type SalesNavField = (typeof SALESNAV_FIELDS)[number]['key']

/**
 * Header spellings seen in the wild, lowercased and trimmed before lookup.
 *
 * These come from hand-built spreadsheets, CRM exports and enrichment providers —
 * not from Sales Navigator, which has no export. See the note at the top of
 * `import.ts`.
 */
export const SALESNAV_ALIASES: Record<string, SalesNavField> = {
  'profile url': 'linkedinUrl', 'linkedin url': 'linkedinUrl', 'person linkedin url': 'linkedinUrl',
  'linkedin profile': 'linkedinUrl', linkedin: 'linkedinUrl', 'profile link': 'linkedinUrl',
  'first name': 'firstName', firstname: 'firstName', 'given name': 'firstName',
  'last name': 'lastName', lastname: 'lastName', surname: 'lastName',
  title: 'title', 'job title': 'title', position: 'title', headline: 'title', 'current title': 'title',
  company: 'companyName', 'company name': 'companyName', 'current company': 'companyName',
  organization: 'companyName', account: 'companyName',
  website: 'companyDomain', 'company website': 'companyDomain', domain: 'companyDomain',
  'company domain': 'companyDomain',
  email: 'email', 'email address': 'email', 'work email': 'email',
  location: 'city', geography: 'city', city: 'city', country: 'country',
}
