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
  // 'log' is the kill switch — nothing leaves, whatever a mailbox is configured
  // with. Anything else permits sending, and which transport is used is then a
  // property of the mailbox: Microsoft 365 goes through Graph, SES through SES.
  EMAIL_TRANSPORT: z.enum(['auto', 'log', 'ses', 'live']).default('auto'),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),

  APOLLO_API_KEY: z.string().optional(),

  // Rewriting drafts. Optional throughout: without a key the Improve button is
  // absent and every other part of drafting works exactly as before.
  OPENAI_API_KEY: z.string().optional(),
  // Deliberately a capable model rather than the cheapest.
  //
  // At this app's volume the whole question is moot on cost: a rewrite is roughly
  // 1,500 tokens in and 150 out, so thirty a day is a couple of million tokens a
  // month. That is pennies on a budget model and a few pounds on a good one, and
  // the output is the actual sentence a prospect reads. Optimising that for a
  // saving smaller than a coffee is the wrong trade.
  //
  // What matters here is instruction-following, not eloquence: the prompt forbids
  // claims outside the supplied facts and imposes a hard character limit, and a
  // weaker model is likelier to quietly ignore both.
  OPENAI_MODEL: z.string().default('gpt-5.6-terra'),
  SALESFORCE_CLIENT_ID: z.string().optional(),
  SALESFORCE_CLIENT_SECRET: z.string().optional(),
})

/**
 * In a `.env` file, `KEY=""` means "I have not set this" — it is how every example
 * file in the world writes a blank to be filled in. Passing it through as the empty
 * string makes each key with a default or an enum reject it, so copying
 * `.env.example` and filling in only the values you need refused to boot with
 * "Invalid environment configuration: EMAIL_TRANSPORT: invalid enum value". Treating
 * blank as absent lets the defaults do their job.
 *
 * Genuinely required keys are unaffected: an absent DATABASE_URL still fails, which
 * is the point of validating at all.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = typeof value === 'string' && value.trim() === '' ? undefined : value
  }
  return out
}

function load() {
  const parsed = schema.safeParse(withoutBlanks(process.env))
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
