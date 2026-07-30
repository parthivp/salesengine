import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto'
import { env } from './env'

/**
 * AES-256-GCM for credentials at rest: OAuth refresh tokens, SMTP passwords,
 * CRM secrets. These are the crown jewels — a database dump must not hand an
 * attacker live access to every tenant's Salesforce org and mailbox.
 */

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'utf8')

export type Sealed = { v: 1; iv: string; tag: string; ct: string }

export function seal(plaintext: string): Sealed {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, KEY, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function unseal(sealed: Sealed): string {
  if (sealed?.v !== 1) throw new Error('Unsupported ciphertext version')
  const decipher = createDecipheriv(ALGO, KEY, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** Convenience for the `credentials Json` columns. */
export function sealObject(obj: unknown): Sealed {
  return seal(JSON.stringify(obj))
}

export function unsealObject<T>(sealed: Sealed): T {
  return JSON.parse(unseal(sealed)) as T
}

// --- token helpers ---------------------------------------------------------

/** Opaque, URL-safe token. Used for sessions, invites and API keys. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Session and API tokens are stored hashed. SHA-256 is correct here (not bcrypt):
 * the input is already high-entropy, and lookups must be fast and constant-time.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
