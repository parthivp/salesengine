import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

/**
 * End-to-end smoke pass.
 *
 * Walks every route as each role, screenshots it, and fails the run on a page
 * error, a console error or a 4xx/5xx response. The point is not the pictures —
 * it is that a build can typecheck, pass 215 unit tests and still throw at
 * runtime on a page nobody opened.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/smoke'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe12345'

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME })
const problems = []

/**
 * An aborted request is the browser cancelling its own speculative work — Next
 * prefetches the sidebar links, and navigating away cancels whichever have not
 * finished. It says nothing about the server, so it is not a failure. Every other
 * failure type still counts.
 */
const isAbort = (errorText) => errorText === 'net::ERR_ABORTED'

async function session(label, email, routes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()

  let current = 'login'
  page.on('pageerror', (e) => problems.push(`[${label}] ${current}: pageerror ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${label}] ${current}: console ${m.text()}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`[${label}] ${current}: ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (r) => {
    const errorText = r.failure()?.errorText ?? 'unknown'
    if (!isAbort(errorText)) {
      problems.push(`[${label}] ${current}: failed ${r.url()} ${errorText}`)
    }
  })

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('#email', email)
  await page.fill('#password', PASSWORD)
  await Promise.all([page.waitForURL('**/dashboard', { timeout: 25_000 }), page.click('button[type=submit]')])
  console.log(`${label}: signed in as ${email}`)

  for (const [name, path] of routes) {
    current = path
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    const status = res?.status() ?? 0
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: true })
    const h1 = await page.locator('h1').first().textContent().catch(() => null)
    console.log(`  ${status} ${path}  ${JSON.stringify((h1 ?? '').trim().slice(0, 40))}`)
  }

  await ctx.close()
  return page
}

const ownerRoutes = [
  ['dashboard', '/dashboard'],
  ['contacts', '/contacts'],
  ['accounts', '/accounts'],
  ['import', '/contacts/import'],
  ['inbox', '/inbox'],
  ['sequences', '/sequences'],
  ['templates', '/templates'],
  ['tasks', '/tasks'],
  ['deals', '/deals'],
  ['reports', '/reports'],
  ['linkedin', '/linkedin'],
  ['admin-users', '/admin/users'],
  ['admin-mailboxes', '/admin/mailboxes'],
  ['admin-integrations', '/admin/integrations'],
  ['admin-settings', '/admin/settings'],
  ['admin-audit', '/admin/audit'],
  ['admin-readiness', '/admin/readiness'],
  ['platform-tenants', '/platform/tenants'],
]

await session('owner', 'parthiv@acme.test', ownerRoutes)

// A rep: the same core routes, plus the admin routes to confirm RBAC refuses
// them rather than rendering them.
await session('rep', 'rohan@acme.test', [
  ['dashboard', '/dashboard'],
  ['contacts', '/contacts'],
  ['tasks', '/tasks'],
  ['linkedin', '/linkedin'],
  ['sequences', '/sequences'],
])

// A different tenant. Every list must be empty — this is the isolation claim
// rendered rather than asserted in a unit test.
await session('globex', 'admin@globex.test', [
  ['dashboard', '/dashboard'],
  ['contacts', '/contacts'],
  ['accounts', '/accounts'],
  ['deals', '/deals'],
  ['reports', '/reports'],
  ['linkedin', '/linkedin'],
  ['admin-users', '/admin/users'],
])

/**
 * The privileged routes, walked as each role, asserting the outcome rather than
 * screenshotting it.
 *
 * This is here because the screenshot sweep above passed while a rep could read the
 * whole user list: every page returned 200, which is exactly what a missing guard
 * looks like. A route being reachable is not the same as it being permitted, so the
 * check has to be on the content.
 */
async function assertRefusals(email, expectations) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('#email', email)
  await page.fill('#password', PASSWORD)
  await Promise.all([page.waitForURL('**/dashboard', { timeout: 25_000 }), page.click('button[type=submit]')])

  console.log(`\nauthorization, as ${email}`)
  for (const [path, expected] of expectations) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    const status = res?.status() ?? 0
    const main = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ')
    const refused = /is not available to your role/.test(main)
    const actual = status >= 500 ? 'error' : refused ? 'refused' : 'allowed'
    const ok = actual === expected
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${path} -> ${actual} (${status}), expected ${expected}`)
    if (!ok) problems.push(`[authz] ${email} ${path}: ${actual} (${status}), expected ${expected}`)
  }

  // The nav must not offer what the role cannot open.
  const offered = await page.locator('aside a').evaluateAll((els) =>
    els.map((e) => e.getAttribute('href')).filter((h) => h?.startsWith('/admin') || h?.startsWith('/platform'))
  )
  const forbidden = expectations.filter(([, e]) => e === 'refused').map(([p]) => p)
  for (const href of offered) {
    if (forbidden.includes(href)) problems.push(`[authz] ${email}: nav offers refused route ${href}`)
  }
  console.log(`  nav privileged links: ${offered.length ? offered.join(' ') : '(none)'}`)

  await ctx.close()
}

const ADMIN_ROUTES = [
  '/admin/users', '/admin/mailboxes', '/admin/integrations',
  '/admin/settings', '/admin/audit', '/admin/readiness', '/platform/tenants',
]

await assertRefusals('rohan@acme.test', ADMIN_ROUTES.map((p) => [p, 'refused']))
await assertRefusals('maya@acme.test', ADMIN_ROUTES.map((p) => [p, 'refused']))
await assertRefusals('parthiv@acme.test', [
  ['/admin/users', 'allowed'],
  ['/admin/mailboxes', 'allowed'],
  ['/admin/integrations', 'allowed'],
  ['/admin/settings', 'allowed'],
  ['/admin/audit', 'allowed'],
  ['/admin/readiness', 'allowed'],
  // This particular owner is the seeded platform admin — they operate the
  // deployment — so the cross-tenant surface is allowed for them.
  ['/platform/tenants', 'allowed'],
])

// The distinction that matters: another tenant's owner has every permission
// inside their own workspace and still cannot reach the cross-tenant surface.
// That is `isPlatformAdmin` doing its job rather than `owner` implying it.
await assertRefusals('admin@globex.test', [
  ['/admin/users', 'allowed'],
  ['/admin/settings', 'allowed'],
  ['/platform/tenants', 'refused'],
])

await browser.close()

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`)
  for (const p of problems) console.log(`  ${p}`)
  process.exit(1)
}
console.log('\nno page errors, no console errors, no failed responses')
