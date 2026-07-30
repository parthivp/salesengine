import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['dotenv/config'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
