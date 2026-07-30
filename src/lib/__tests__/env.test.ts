import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The env module reads process.env once at import, so these tests exercise the
 * normalisation directly rather than trying to re-import it under different
 * conditions — a stale module cache would make that test lie.
 */
function withoutBlanks(source: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = typeof value === 'string' && value.trim() === '' ? undefined : value
  }
  return out
}

describe('environment normalisation', () => {
  it('treats a blank value as unset, the way a .env file means it', () => {
    // Copying .env.example and filling in only what you need used to refuse to
    // boot: EMAIL_TRANSPORT="" is not a member of the enum.
    const normalised = withoutBlanks({ EMAIL_TRANSPORT: '', REDIS_URL: '   ', APP_URL: '' })
    expect(normalised.EMAIL_TRANSPORT).toBeUndefined()
    expect(normalised.REDIS_URL).toBeUndefined()
    expect(normalised.APP_URL).toBeUndefined()
  })

  it('leaves real values alone, including ones with inner spaces', () => {
    const normalised = withoutBlanks({ A: 'ses', B: 'a b', C: ' padded ' })
    expect(normalised).toEqual({ A: 'ses', B: 'a b', C: ' padded ' })
  })

  it('matches the loader the app actually uses', () => {
    // Guards against the normalisation being changed in one place only.
    const src = readFileSync(join(process.cwd(), 'src/lib/env.ts'), 'utf8')
    expect(src).toContain('withoutBlanks(process.env)')
    expect(src).toMatch(/value\.trim\(\) === ''/)
  })
})

describe('.env.example', () => {
  const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8')

  it('documents every key the schema knows about', () => {
    const schema = readFileSync(join(process.cwd(), 'src/lib/env.ts'), 'utf8')
    const keys = [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) {
      expect(example, `${key} missing from .env.example`).toMatch(new RegExp(`^${key}=`, 'm'))
    }
  })

  it('ships no credential values', () => {
    // Every secret must be blank in the template. A real key committed here is the
    // classic way one leaks.
    for (const key of ['AUTH_SECRET', 'ENCRYPTION_KEY', 'AWS_SECRET_ACCESS_KEY',
                       'APOLLO_API_KEY', 'SALESFORCE_CLIENT_SECRET']) {
      const line = example.split('\n').find((l) => l.startsWith(`${key}=`))
      expect(line, key).toBe(`${key}=""`)
    }
  })

  it('defaults the transport to log rather than auto', () => {
    // 'auto' sends for real the moment AWS credentials happen to be present, and
    // in a fresh checkout that is not what anyone means.
    expect(example).toMatch(/^EMAIL_TRANSPORT="log"$/m)
  })

  it('points the runtime and migration URLs at different roles', () => {
    // If both use the owner role, row-level security is bypassed everywhere and the
    // tenant isolation tests are the only thing still enforcing it.
    const runtime = /^DATABASE_URL="([^"]*)"/m.exec(example)?.[1] ?? ''
    const direct = /^DIRECT_DATABASE_URL="([^"]*)"/m.exec(example)?.[1] ?? ''
    expect(runtime).toContain('salesengine_app')
    expect(direct).toContain('salesengine:')
    expect(runtime).not.toBe(direct)
  })
})
