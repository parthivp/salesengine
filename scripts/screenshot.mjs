import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/shots7'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`) })

async function shot(name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 800)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false })
  console.log(`captured ${name}`)
}

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#email', 'parthiv@acme.test')
await page.fill('#password', process.env.SEED_PASSWORD ?? 'ChangeMe12345')
await Promise.all([page.waitForURL('**/dashboard', { timeout: 20000 }), page.click('button[type=submit]')])

await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' })
await shot('01-tasks')

// Open a complete panel so the outcome buttons are visible
const completeBtn = page.locator('button:has-text("Complete")').first()
if (await completeBtn.count()) { await completeBtn.click(); await shot('02-task-outcomes') }

await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle' })
await shot('03-deals-board')

await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' })
await shot('04-reports', { full: true })

// Hover the trend chart to prove the crosshair + tooltip work
const svg = page.locator('svg').first()
const box = await svg.boundingBox()
if (box) {
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5)
  await page.waitForTimeout(500)
  await shot('05-reports-hover')
}

// Table view twin
const tableToggle = page.locator('button[title="Table view"]').first()
if (await tableToggle.count()) { await tableToggle.click(); await shot('06-reports-table-view') }

await browser.close()
if (problems.length) { console.log('\nISSUES:'); problems.forEach((p) => console.log('  ' + p)); process.exit(1) }
console.log('\nno console errors or 5xx responses')
