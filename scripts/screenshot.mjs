import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/shots2'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

const failures = []
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`))
page.on('response', (r) => { if (r.status() >= 500) failures.push(`${r.status()} ${r.url()}`) })

async function shot(name, opts = {}) {
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false })
  console.log(`captured ${name}`)
}

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#email', 'parthiv@acme.test')
await page.fill('#password', process.env.SEED_PASSWORD ?? 'ChangeMe12345')
await Promise.all([page.waitForURL('**/dashboard', { timeout: 20000 }), page.click('button[type=submit]')])
await shot('01-dashboard')

await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle' })
await shot('02-contacts')

// Exercise the debounced search and a status facet.
await page.fill('input[aria-label="Search contacts"]', 'sales')
await page.waitForTimeout(900)
await shot('03-contacts-search')

await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle' })
const firstRow = page.locator('table tbody tr a').first()
await firstRow.click()
await page.waitForLoadState('networkidle')
await shot('04-contact-detail', { full: true })

await page.goto(`${BASE}/accounts`, { waitUntil: 'networkidle' })
await shot('05-accounts')

const firstAccount = page.locator('table tbody tr a').first()
await firstAccount.click()
await page.waitForLoadState('networkidle')
await shot('06-account-detail')

await page.goto(`${BASE}/contacts/import`, { waitUntil: 'networkidle' })
await shot('07-import-upload')

// Drive the import wizard with a real file so the mapping step is genuine.
await page.setInputFiles('input[type=file]', {
  name: 'sales-nav-export.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'First Name,Last Name,Email,Title,Company,Company Domain\n' +
    'Imogen,Ashworth,imogen@harbourline.co,VP of Sales,Harbourline,harbourline.co\n' +
    'Theo,Vance,theo@harbourline.co,Sales Manager,Harbourline,harbourline.co\n' +
    'Nia,Osei,nia@brightloop.dev,Head of Growth,BrightLoop,brightloop.dev\n' +
    ',,broken-row,Analyst,Nowhere,nowhere.test\n'
  ),
})
await page.waitForTimeout(900)
await shot('08-import-mapping', { full: true })

await page.click('text=Validate without importing')
await page.waitForTimeout(2500)
await shot('09-import-dryrun', { full: true })

await browser.close()

if (failures.length) {
  console.log('\nISSUES DETECTED:')
  failures.forEach((f) => console.log('  ' + f))
  process.exit(1)
}
console.log('\nno console errors or 5xx responses')
