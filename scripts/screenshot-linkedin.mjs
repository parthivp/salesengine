import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? '/tmp/shots-p6'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`) })
page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`) })

async function shot(name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 700)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false })
  console.log(`captured ${name}`)
}

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#email', 'parthiv@acme.test')
await page.fill('#password', process.env.SEED_PASSWORD ?? 'ChangeMe12345')
await Promise.all([page.waitForURL('**/dashboard', { timeout: 20000 }), page.click('button[type=submit]')])

await page.goto(`${BASE}/linkedin`, { waitUntil: 'networkidle' })
await shot('01-queue', { full: true })

// The first card, framed on its own so the draft, checks and outcome buttons read.
const firstCard = page.locator('main li').filter({ has: page.locator('textarea') }).first()
if (await firstCard.count()) {
  await firstCard.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await firstCard.screenshot({ path: `${OUT}/02-card.png` })
  console.log('captured 02-card')
}

// The Sales Navigator import panel.
const importBtn = page.locator('button', { hasText: /import/i }).first()
if (await importBtn.count()) {
  await importBtn.click()
  await shot('03-import', { full: true })
}

// Verify the extension endpoint answers with the session cookie, which is
// exactly how the extension calls it. Text first — a 404 returns HTML and
// blowing up on JSON.parse hides the actual status.
const probe = async (init) =>
  page.evaluate(async ({ init }) => {
    const r = await fetch('/api/extension/queue', { credentials: 'include', ...init })
    const text = await r.text()
    return { status: r.status, body: text.slice(0, 200) }
  }, { init })

console.log('extension GET:', JSON.stringify(await probe(undefined)))
console.log(
  'extension POST bad id:',
  JSON.stringify(
    await probe({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'does-not-exist', outcome: 'sent' }),
    })
  )
)
console.log(
  'extension POST bad payload:',
  JSON.stringify(
    await probe({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'nonsense' }),
    })
  )
)

console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no page errors')
await browser.close()
