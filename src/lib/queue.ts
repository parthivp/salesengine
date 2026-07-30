import { Queue, type JobsOptions, type QueueOptions } from 'bullmq'
import IORedis from 'ioredis'
import { env } from './env'

/**
 * One Redis connection shared by all queues on the producer side.
 * `maxRetriesPerRequest: null` is required by BullMQ for blocking commands.
 */
export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

export const QUEUE = {
  sequence: 'sequence',
  email: 'email',
  enrichment: 'enrichment',
  crmSync: 'crm-sync',
  scoring: 'scoring',
  maintenance: 'maintenance',
} as const

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE]

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
}

const opts: QueueOptions = { connection: redis, defaultJobOptions }

const registry = new Map<QueueName, Queue>()

export function queue(name: QueueName): Queue {
  let q = registry.get(name)
  if (!q) {
    q = new Queue(name, opts)
    registry.set(name, q)
  }
  return q
}

// --- job payloads ----------------------------------------------------------

export type JobMap = {
  'sequence:tick': Record<string, never>
  'sequence:step': { enrollmentId: string; tenantId: string }
  'sequence:enroll': { tenantId: string; sequenceId: string; contactIds: string[]; enrolledById?: string }
  'email:send': { tenantId: string; messageId: string }
  'email:poll-replies': { tenantId: string; mailboxId: string }
  'enrichment:contact': { tenantId: string; contactIds: string[] }
  'enrichment:account': { tenantId: string; accountIds: string[] }
  'crm:pull': { tenantId: string; connectionId: string; object: string }
  'crm:push': { tenantId: string; connectionId: string; object: string; localIds: string[] }
  'scoring:recompute': { tenantId: string; contactIds?: string[] }
  'maintenance:reset-daily-caps': Record<string, never>
  'maintenance:expire-sessions': Record<string, never>
}

export type JobName = keyof JobMap

const JOB_QUEUE: Record<JobName, QueueName> = {
  'sequence:tick': QUEUE.sequence,
  'sequence:step': QUEUE.sequence,
  'sequence:enroll': QUEUE.sequence,
  'email:send': QUEUE.email,
  'email:poll-replies': QUEUE.email,
  'enrichment:contact': QUEUE.enrichment,
  'enrichment:account': QUEUE.enrichment,
  'crm:pull': QUEUE.crmSync,
  'crm:push': QUEUE.crmSync,
  'scoring:recompute': QUEUE.scoring,
  'maintenance:reset-daily-caps': QUEUE.maintenance,
  'maintenance:expire-sessions': QUEUE.maintenance,
}

export async function enqueue<N extends JobName>(
  name: N,
  data: JobMap[N],
  options: JobsOptions = {}
) {
  return queue(JOB_QUEUE[name]).add(name, data, options)
}

/**
 * Repeating jobs. `jobId` is fixed so re-registering on every boot replaces
 * rather than duplicates the schedule.
 */
export async function registerRepeatables() {
  await queue(QUEUE.sequence).add(
    'sequence:tick',
    {},
    { repeat: { every: 60_000 }, jobId: 'repeat:sequence:tick' }
  )
  await queue(QUEUE.maintenance).add(
    'maintenance:reset-daily-caps',
    {},
    { repeat: { pattern: '5 0 * * *' }, jobId: 'repeat:reset-daily-caps' }
  )
  await queue(QUEUE.maintenance).add(
    'maintenance:expire-sessions',
    {},
    { repeat: { pattern: '30 3 * * *' }, jobId: 'repeat:expire-sessions' }
  )
}

export async function closeQueues() {
  await Promise.allSettled([...registry.values()].map((q) => q.close()))
  await redis.quit()
}
