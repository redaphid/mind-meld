import { defineConfig } from 'vitest/config'

// End-to-end tests against the REAL local index: the Postgres and Chroma the
// docker stack publishes on the host (ports 5433 and 8001, see CLAUDE.md), and
// an HTTP server started from this checkout. Not part of `pnpm test` or CI --
// they need a populated index, and what they assert about is its data.
//
// Host defaults are set BEFORE dotenv loads, because .env names the in-network
// docker hostnames and dotenv never overrides a variable that is already set.
process.env.POSTGRES_HOST ??= 'localhost'
process.env.POSTGRES_PORT ??= '5433'
process.env.CHROMA_HOST ??= 'localhost'
process.env.CHROMA_PORT ??= '8001'
await import('dotenv/config')

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
