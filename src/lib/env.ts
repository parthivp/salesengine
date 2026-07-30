import { z } from 'zod'

/**
 * Fail fast on misconfiguration. A missing AUTH_SECRET in production should stop
 * the process at boot, not produce silently-forgeable sessions at 3am.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  APP_URL: z.string().url().default('http://localhost:3000'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .length(32, 'ENCRYPTION_KEY must be exactly 32 bytes for AES-256-GCM'),

  /**
   * Which transport actually sends. 'auto' picks SES when credentials exist.
   *
   * This exists because ambient AWS credentials — a CI runner, a dev laptop with
   * a shared profile, this project's own sandbox — would otherwise silently arm
   * real sending. Tests and local development set 'log'; production sets 'ses'
   * or leaves it on 'auto'.
   */
  EMAIL_TRANSPORT: z.enum(['auto', 'log', 'ses']).default('auto'),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),

  APOLLO_API_KEY: z.string().optional(),
  SALESFORCE_CLIENT_ID: z.string().optional(),
  SALESFORCE_CLIENT_SECRET: z.string().optional(),
})

function load() {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

export const env = load()
export type Env = typeof env

export const isProd = env.NODE_ENV === 'production'
export const isDev = env.NODE_ENV === 'development'
