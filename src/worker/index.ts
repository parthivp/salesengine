import 'dotenv/config'
import { Worker, type Job } from 'bullmq'
import { redis, QUEUE, registerRepeatables, closeQueues, type JobName } from '../lib/queue'
import { logger } from '../lib/logger'
import { disconnect } from '../lib/db'
import { handlers } from './handlers'

/**
 * The worker process.
 *
 * Deliberately separate from the Next.js server: sequence scheduling, email
 * sending and CRM sync are long-running and must not share a request lifecycle.
 * One process, several BullMQ Workers, each with its own concurrency budget.
 */

const CONCURRENCY: Record<string, number> = {
  [QUEUE.sequence]: 10,
  [QUEUE.email]: 5, // deliberately low — sending is rate-limited by mailbox caps anyway
  [QUEUE.enrichment]: 3, // Apollo rate limits
  [QUEUE.crmSync]: 3, // Salesforce API budget
  [QUEUE.scoring]: 5,
  [QUEUE.maintenance]: 1,
}

const workers: Worker[] = []

async function dispatch(job: Job) {
  const handler = handlers[job.name as JobName]
  if (!handler) {
    logger.warn({ job: job.name }, 'no handler registered; discarding')
    return
  }
  const started = Date.now()
  const log = logger.child({ job: job.name, jobId: job.id })
  try {
    const result = await handler(job.data as never)
    log.debug({ ms: Date.now() - started }, 'job complete')
    return result
  } catch (err) {
    log.error({ err, ms: Date.now() - started, attempt: job.attemptsMade + 1 }, 'job failed')
    throw err
  }
}

function start() {
  for (const [name, concurrency] of Object.entries(CONCURRENCY)) {
    const w = new Worker(name, dispatch, {
      connection: redis,
      concurrency,
      // Give jobs room; the scheduler tick fans out rather than doing work inline.
      lockDuration: 60_000,
    })
    w.on('error', (err) => logger.error({ err, queue: name }, 'worker error'))
    workers.push(w)
    logger.info({ queue: name, concurrency }, 'worker started')
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down worker')
  await Promise.allSettled(workers.map((w) => w.close()))
  await closeQueues()
  await disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))

async function main() {
  start()
  await registerRepeatables()
  logger.info('repeatable schedules registered')
}

void main()
