import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/shots4'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`) })

async function shot(name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 700)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false })
  console.log(`captured ${name}`)
}

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#email', 'parthiv@acme.test')
await page.fill('#password', process.env.SEED_PASSWORD ?? 'ChangeMe12345')
await Promise.all([page.waitForURL('**/dashboard', { timeout: 20000 }), page.click('button[type=submit]')])

for (const [path, name, opts] of [
  ['/sequences', '01-sequences', {}],
  ['/templates', '02-templates', { wait: 2000, full: true }],
  ['/admin/mailboxes', '03-mailboxes', { full: true }],
  ['/inbox', '04-inbox', {}],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await shot(name, opts)
}

// Sequence detail for the seeded sequence
await page.goto(`${BASE}/sequences`, { waitUntil: 'networkidle' })
const link = page.locator('table tbody tr a').first()
await link.click()
await page.waitForLoadState('networkidle')
await shot('05-sequence-detail', { full: true })

// Deliberately break a template to show the linter refusing it
await page.goto(`${BASE}/templates`, { waitUntil: 'networkidle' })
await page.fill('#tpl-name', 'Bad example')
await page.fill('#tpl-subject', 'ACT NOW — LIMITED TIME OFFER!!')
await page.fill('#tpl-body', 'Click here to claim your free gift and earn extra cash risk free. Guarantee! {{favourite_colour}}')
await page.waitForTimeout(2200)
await shot('06-template-linter-blocking', { full: true })

await browser.close()
if (problems.length) {
  console.log('\nISSUES:')
  problems.forEach((p) => console.log('  ' + p))
  process.exit(1)
}
console.log('\nno console errors or 5xx responses')
