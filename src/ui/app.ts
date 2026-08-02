// The browser UI as its own service. Serves public/ at the root and
// reverse-proxies the API surface to the mcp process, so one tunnel ingress
// rule pointed here keeps every path — UI, REST, and MCP — working from the
// same hostname. The mcp service stays fully standalone: MCP clients keep
// hitting it directly, and it still bundles the UI as a fallback.
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import express, { type Express } from 'express'
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'

// Every path the API service owns. Anything else is the static app shell.
// Kept in lockstep with the routes in src/mcp/http-server.ts.
export const API_PREFIXES = [
  '/mcp',
  '/api',
  '/status',
  '/health',
  '/logs',
  '/openapi.yaml',
]

// Hop-by-hop headers must not be forwarded in either direction; Node re-frames
// the message itself (RFC 9110 §7.6.1).
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

// DNS-rebinding protection, same mechanism as the mcp service: the proxy
// rewrites the Host header for the upstream, so the check has to happen here
// or a malicious page resolving to this port could read API responses.
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'ui']

export type UiAppOptions = {
  // Base URL of the API service, e.g. http://mcp:3000
  upstream: string
  // Directory of static files; defaults to the repo's public/
  publicDir?: string
  // Extra Host header values to accept (tunnel hostnames), added to defaults
  allowedHosts?: string[]
  // Reported by /healthz
  version?: string
}

export const createUiApp = ({ upstream, publicDir, allowedHosts = [], version = 'dev' }: UiAppOptions): Express => {
  const upstreamUrl = new URL(upstream)
  const staticDir = publicDir ?? fileURLToPath(new URL('../../public', import.meta.url))

  const app = express()
  app.use(hostHeaderValidation([...DEFAULT_ALLOWED_HOSTS, ...allowedHosts]))

  // Liveness of this container itself, distinct from /health which belongs to
  // (and is proxied to) the API service.
  app.get('/healthz', (_req: any, res: any) => {
    res.json({ status: 'ok', name: 'mindmeld-ui', version, upstream: upstreamUrl.origin })
  })

  // No body parsing anywhere in this app: requests stream through untouched,
  // which is what keeps the MCP Streamable HTTP transport working end-to-end.
  const proxy = (req: any, res: any) => {
    const headers: Record<string, any> = { ...req.headers, host: upstreamUrl.host }
    for (const h of HOP_BY_HOP) delete headers[h]
    headers['x-forwarded-host'] = req.headers.host ?? ''
    headers['x-forwarded-for'] = req.socket?.remoteAddress ?? ''

    const upReq = httpRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 80,
        path: req.originalUrl,
        method: req.method,
        headers,
      },
      upRes => {
        const resHeaders = { ...upRes.headers }
        for (const h of HOP_BY_HOP) delete resHeaders[h]
        res.writeHead(upRes.statusCode ?? 502, resHeaders)
        upRes.pipe(res)
      }
    )

    upReq.on('error', (error: Error) => {
      console.error(`[UI] Upstream error for ${req.method} ${req.originalUrl}:`, error.message)
      if (!res.headersSent)
        res.status(502).json({ status: 'error', error: `API upstream unreachable: ${error.message}` })
      else res.end()
    })

    // If the client goes away mid-stream, stop the upstream request too.
    res.on('close', () => upReq.destroy())

    req.pipe(upReq)
  }

  for (const prefix of API_PREFIXES) app.use(prefix, proxy)

  // Same caching contract as the mcp service's copy: the app shell and the
  // service worker are revalidated every load, so the UI can never pin itself
  // to a stale API contract.
  app.use(
    express.static(staticDir, {
      setHeaders: (res, path) => {
        if (path.endsWith('.html') || path.endsWith('sw.js'))
          res.setHeader('Cache-Control', 'no-cache')
      },
    })
  )

  return app
}
