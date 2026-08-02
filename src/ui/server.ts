// Entry point for the ui container (Dockerfile.ui). Configuration mirrors the
// mcp service: ALLOWED_HOSTS is a comma-separated *addition* to the localhost
// defaults, never a replacement, so a Cloudflare-tunnel hostname goes there.
import { createRequire } from 'node:module'
import { createUiApp } from './app.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

const UI_PORT = process.env.UI_PORT ? parseInt(process.env.UI_PORT, 10) : 3000
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://mcp:3000'

const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map(h => h.trim())
  .filter(Boolean)

const intEnv = (name: string) => {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const app = createUiApp({
  upstream: UPSTREAM_URL,
  allowedHosts,
  version,
  connectTimeoutMs: intEnv('UPSTREAM_CONNECT_TIMEOUT_MS'),
  headerTimeoutMs: intEnv('UPSTREAM_HEADER_TIMEOUT_MS'),
})

app.listen(UI_PORT, () => {
  console.log(`[UI] Mindmeld UI listening on http://localhost:${UI_PORT}, proxying API to ${UPSTREAM_URL}`)
})
