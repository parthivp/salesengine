import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Creates `.env` from `.env.example` and fills in the secrets that have no
 * sensible default.
 *
 * This exists because the first run of `docker compose up` fails otherwise, and
 * the failure is hard to read: compose reports "required variable
 * APP_DB_PASSWORD is missing a value" *identically* whether `.env` is absent or
 * present-with-an-empty-value. Copying `.env.example` is not enough — it ships
 * those keys as `""`, which compose treats exactly like unset.
 *
 * Plain .mjs with no dependencies, so it runs through the Node image without
 * anything installed on the host:
 *
 *   docker run --rm -v "${PWD}:/w" -w /w node:22-alpine node scripts/init-env.mjs
 *
 * Never overwrites a value that is already set. Re-running it is safe, and fills
 * in only what is still blank.
 */

const root = process.cwd()
const envPath = join(root, '.env')
const examplePath = join(root, '.env.example')

/**
 * Hex only, deliberately.
 *
 * These values are substituted into database URLs, where a `@`, `:`, `/`, `#` or
 * `?` silently produces a malformed connection string rather than an error you
 * can read. Base64 would be denser and would eventually generate one of those.
 */
const hex = (bytes) => randomBytes(bytes).toString('hex')

const GENERATORS = {
  // Session signing. The schema requires at least 32 characters.
  AUTH_SECRET: () => hex(32),
  // AES-256-GCM key. The schema requires exactly 32 characters.
  ENCRYPTION_KEY: () => hex(16),
  // Password for the restricted runtime database role.
  APP_DB_PASSWORD: () => hex(16),
}

function main() {
  if (!existsSync(examplePath)) {
    console.error('✗ .env.example not found. Run this from the project root.')
    process.exit(1)
  }

  const created = !existsSync(envPath)
  if (created) {
    copyFileSync(examplePath, envPath)
    console.log('✓ created .env from .env.example')
  } else {
    console.log('· .env already exists — filling in blanks only, keeping what is set')
  }

  let contents = readFileSync(envPath, 'utf8')
  const filled = []
  const kept = []

  for (const [key, generate] of Object.entries(GENERATORS)) {
    // Matches KEY=, KEY="", KEY='' and any existing value.
    const line = new RegExp(`^${key}=(.*)$`, 'm')
    const match = line.exec(contents)
    const current = match ? match[1].trim().replace(/^["']|["']$/g, '') : ''

    if (current) {
      kept.push(key)
      continue
    }

    const value = generate()
    contents = match
      ? contents.replace(line, `${key}="${value}"`)
      : `${contents.trimEnd()}\n${key}="${value}"\n`
    filled.push(key)
  }

  writeFileSync(envPath, contents, 'utf8')

  if (filled.length) console.log(`✓ generated: ${filled.join(', ')}`)
  if (kept.length) console.log(`· left alone (already set): ${kept.join(', ')}`)

  // Report rather than assume: the whole point is that the operator can see the
  // state that compose is about to interpolate from.
  const missing = Object.keys(GENERATORS).filter((k) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(contents)
    return !m || !m[1].trim().replace(/^["']|["']$/g, '')
  })

  if (missing.length) {
    console.error(`\n✗ still empty: ${missing.join(', ')} — compose will refuse to start.`)
    process.exit(1)
  }

  console.log('\n✓ .env is ready. Next: docker compose up -d --build')
}

main()
