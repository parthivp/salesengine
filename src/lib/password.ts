import bcrypt from 'bcryptjs'

/**
 * Password hashing and policy.
 *
 * Split out of `auth.ts` because that module imports `server-only`, which throws
 * the moment it is loaded outside a React server context — so the CLI scripts
 * that need to create an account could not use it. These are pure functions with
 * no request-scoped state, so there is nothing server-only about them.
 *
 * Cost 12: roughly 250ms per hash on ordinary hardware, which is slow enough to
 * make offline cracking expensive and fast enough that a login does not feel it.
 */

const COST = 12

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/** Returns a message when the password is unacceptable, or null when it is fine. */
export function validatePassword(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters.'
  if (password.length > 200) return 'Password must be under 200 characters.'
  if (/^\d+$/.test(password)) return 'Password cannot be only digits.'
  return null
}
