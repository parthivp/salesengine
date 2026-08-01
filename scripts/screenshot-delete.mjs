import { chromium } from 'playwright'

/**
 * Drives the delete dialogs in a real browser and captures what the operator
 * actually sees. Written because a preview that is correct in a unit test and
 * unreadable on screen is still a bad confirmation — the whole point of the
 * feature is that the sentence in the dialog is true and legible.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/del'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
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

// --- an account with people on it ------------------------------------------
await page.goto(`${BASE}/accounts`, { waitUntil: 'networkidle' })
const firstAccount = page.locator('table a[href^="/accounts/"]').first()
await firstAccount.click()
await page.waitForLoadState('networkidle')
console.log('account page:', page.url())

await page.click('button[aria-label="Delete"], button:has-text("Delete")')
await page.waitForTimeout(1200)
await shot('01-account-default')

const cascade = page.locator('div[role=dialog] input[type=checkbox]').first()
if (await cascade.count()) {
  await cascade.check()
  await page.waitForTimeout(1400)
  await shot('02-account-cascade')
} else {
  problems.push('no cascade checkbox on the account dialog')
}

await page.keyboard.press('Escape')
await page.mouse.click(10, 10)

// --- contacts: selection and the bulk bar ----------------------------------
await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle' })
const boxes = page.locator('tbody input[type=checkbox]')
const n = Math.min(3, await boxes.count())
for (let i = 0; i < n; i++) await boxes.nth(i).check()
await shot('03-contacts-selected')

await page.click('button:has-text("Delete")')
await page.waitForTimeout(1200)
await shot('04-contacts-dialog')

await browser.close()
if (problems.length) { console.log('\nISSUES:'); problems.forEach((p) => console.log('  ' + p)); process.exit(1) }
console.log('\nno console errors or 5xx responses')
