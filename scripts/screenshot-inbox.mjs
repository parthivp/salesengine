import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/inbox'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`) })

async function shot(name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 900)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false })
  console.log(`captured ${name}`)
}

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#email', 'parthiv@acme.test')
await page.fill('#password', process.env.SEED_PASSWORD ?? 'ChangeMe12345')
await Promise.all([page.waitForURL('**/dashboard', { timeout: 30000 }), page.click('button[type=submit]')])

await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' })
await shot('01-inbox-replies')

await page.click('button:has-text("Other mail")')
await page.waitForLoadState('networkidle')
await shot('02-inbox-other')

// Select a couple and open the delete dialog
const boxes = page.locator('ul li input[type=checkbox]')
const n = Math.min(2, await boxes.count())
for (let i = 0; i < n; i++) await boxes.nth(i).check()
await shot('03-inbox-selected')
await page.click('button:has-text("Delete")')
await page.waitForTimeout(1200)
await shot('04-inbox-delete')
await page.keyboard.press('Escape')
await page.mouse.click(5, 5)

// The parser page
await page.goto(`${BASE}/linkedin/paste`, { waitUntil: 'networkidle' })
await shot('05-paste-empty')

await page.setInputFiles('input[type=file]', 'fixtures/salesnav/search-results.html')
await page.waitForTimeout(3500)
await shot('06-paste-review', { full: true })

await browser.close()
if (problems.length) { console.log('\nISSUES:'); problems.forEach((p) => console.log('  ' + p)); process.exit(1) }
console.log('\nno console errors or 5xx responses')
