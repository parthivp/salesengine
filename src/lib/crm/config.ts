import { env } from '../env'

/**
 * Lives outside the server-actions module because a `'use server'` file may only
 * export async functions — a synchronous export there is a build error.
 */
export function salesforceConfigured(): boolean {
  return Boolean(env.SALESFORCE_CLIENT_ID && env.SALESFORCE_CLIENT_SECRET)
}
