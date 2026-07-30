import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/shots6'
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

await page.goto(`${BASE}/admin/integrations`, { waitUntil: 'networkidle' })
await shot('01-integrations', { full: true })

// Exercise the mapping validator so the screenshot shows a real result
const validate = page.locator('text=Validate').first()
if (await validate.count()) {
  await validate.click()
  await page.waitForTimeout(1500)
  await shot('02-mapping-validated', { full: true })
}

await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
await shot('03-dashboard')

await browser.close()
if (problems.length) {
  console.log('\nISSUES:'); problems.forEach((p) => console.log('  ' + p)); process.exit(1)
}
console.log('\nno console errors or 5xx responses')
