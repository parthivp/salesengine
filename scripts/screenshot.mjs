import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/shots'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

async function shot(name) {
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  console.log(`captured ${name}`)
}

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await shot('01-login')

await page.fill('#email', 'parthiv@acme.test')
await page.fill('#password', process.env.SEED_PASSWORD ?? 'ChangeMe12345')
await Promise.all([
  page.waitForURL('**/dashboard', { timeout: 20000 }),
  page.click('button[type=submit]'),
])
await shot('02-dashboard')

await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' })
await shot('03-admin-users')

await page.goto(`${BASE}/sequences`, { waitUntil: 'networkidle' })
await shot('04-sequences-placeholder')

await browser.close()
console.log('done')
