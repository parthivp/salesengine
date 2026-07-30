import pino from 'pino'
import { env, isProd } from './env'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  base: { env: env.NODE_ENV },
  // Credentials and tokens must never reach the log sink.
  redact: {
    paths: [
      'password', '*.password', 'passwordHash', '*.passwordHash',
      'token', '*.token', 'tokenHash', '*.tokenHash',
      'credentials', '*.credentials', 'accessToken', '*.accessToken',
      'refreshToken', '*.refreshToken', 'authorization', 'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  transport: isProd
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
})

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings)
}
