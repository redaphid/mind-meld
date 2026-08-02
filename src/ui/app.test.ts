import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createUiApp, API_PREFIXES } from './app.js'

type Seen = { method: string; url: string; body: string; host?: string }

// A stub standing in for the mcp service: records what it received, answers
// with a recognisable envelope.
const startUpstream = () =>
  new Promise<{ server: Server; port: number; seen: Seen[] }>(resolve => {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, body, host: req.headers.host })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ status: 'ok', from: 'upstream', url: req.url }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, seen }))
  })

const rawGet = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res: IncomingMessage) => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })

describe('createUiApp', () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>
  let ui: Server
  let uiPort: number
  let base: string

  beforeAll(async () => {
    upstream = await startUpstream()

    const publicDir = await mkdtemp(join(tmpdir(), 'mindmeld-ui-test-'))
    await writeFile(join(publicDir, 'index.html'), '<title>mindmeld test shell</title>')
    await writeFile(join(publicDir, 'sw.js'), '// stub service worker')

    const app = createUiApp({
      upstream: `http://127.0.0.1:${upstream.port}`,
      publicDir,
      version: 'test',
    })
    await new Promise<void>(resolve => {
      ui = app.listen(0, '127.0.0.1', () => resolve())
    })
    uiPort = (ui.address() as AddressInfo).port
    base = `http://127.0.0.1:${uiPort}`
  })

  afterAll(async () => {
    ui?.close()
    upstream?.server.close()
  })

  it('serves the app shell at the root, revalidated every load', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('mindmeld test shell')
  })

  it('serves the service worker with no-cache', async () => {
    const res = await fetch(`${base}/sw.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('answers its own liveness on /healthz without touching the upstream', async () => {
    const before = upstream.seen.length
    const res = await fetch(`${base}/healthz`)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'ok', name: 'mindmeld-ui', version: 'test' })
    expect(upstream.seen.length).toBe(before)
  })

  it.each(API_PREFIXES.map(p => [p]))('proxies %s to the API service', async prefix => {
    const res = await fetch(`${base}${prefix}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', from: 'upstream', url: prefix })
  })

  it('forwards the full path and query string', async () => {
    const res = await fetch(`${base}/api/search?q=hello+world&mode=hybrid`)
    const body = (await res.json()) as { url: string }
    expect(body.url).toBe('/api/search?q=hello+world&mode=hybrid')
  })

  it('streams a POST body through untouched', async () => {
    const payload = JSON.stringify({ id: 7, limit: 100 })
    const res = await fetch(`${base}/api/quarantine/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(res.status).toBe(200)
    const hit = upstream.seen.at(-1)!
    expect(hit.method).toBe('POST')
    expect(hit.url).toBe('/api/quarantine/retry')
    expect(hit.body).toBe(payload)
  })

  it('rewrites the Host header so the upstream host allowlist passes', async () => {
    await fetch(`${base}/status`)
    expect(upstream.seen.at(-1)!.host).toBe(`127.0.0.1:${upstream.port}`)
  })

  it('rejects an unlisted Host header (DNS-rebinding protection)', async () => {
    const res = await rawGet(uiPort, '/', { host: 'evil.example.com' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('answers 504 when the upstream accepts the connection but never responds', async () => {
    // A stalled upstream, not a dead one: the TCP server accepts and then
    // says nothing, which no ECONNREFUSED handler would ever catch.
    const sockets: import('node:net').Socket[] = []
    const stalled: TcpServer = createTcpServer(socket => sockets.push(socket))
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve))
    const stalledPort = (stalled.address() as AddressInfo).port

    const app = createUiApp({
      upstream: `http://127.0.0.1:${stalledPort}`,
      publicDir: await mkdtemp(join(tmpdir(), 'mindmeld-ui-test-')),
      version: 'test',
      headerTimeoutMs: 300,
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (server.address() as AddressInfo).port

    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(504)
    const body = (await res.json()) as { status: string; error: string }
    expect(body.status).toBe('error')
    expect(body.error).toContain('no response within 300ms')
    // It answered because the deadline fired, not because something crashed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)

    server.close()
    for (const s of sockets) s.destroy()
    await new Promise<void>(resolve => stalled.close(() => resolve()))
  })

  it('does not cut off a response that streams past the header deadline', async () => {
    // Headers arrive immediately, then the body drips out slower than the
    // header deadline — the MCP SSE shape. The stream must survive.
    const slow = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first')
      setTimeout(() => res.end('-last'), 250)
    })
    await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve))
    const slowPort = (slow.address() as AddressInfo).port

    const app = createUiApp({
      upstream: `http://127.0.0.1:${slowPort}`,
      publicDir: await mkdtemp(join(tmpdir(), 'mindmeld-ui-test-')),
      version: 'test',
      headerTimeoutMs: 100,
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (server.address() as AddressInfo).port

    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('first-last')

    server.close()
    await new Promise<void>(resolve => slow.close(() => resolve()))
  })

  it('ends the response instead of hanging when the upstream dies mid-stream', async () => {
    const dying = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      setTimeout(() => res.socket?.destroy(), 50)
    })
    await new Promise<void>(resolve => dying.listen(0, '127.0.0.1', resolve))
    const dyingPort = (dying.address() as AddressInfo).port

    const app = createUiApp({
      upstream: `http://127.0.0.1:${dyingPort}`,
      publicDir: await mkdtemp(join(tmpdir(), 'mindmeld-ui-test-')),
      version: 'test',
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (server.address() as AddressInfo).port

    // The proxy must terminate the response promptly — the test itself would
    // time out if the client were left waiting forever.
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(200)
    const text = await res.text().catch(() => 'aborted')
    expect(['partial', 'aborted']).toContain(text)

    server.close()
    await new Promise<void>(resolve => dying.close(() => resolve()))
  })

  it('serves the real public/ directory when no publicDir is given', async () => {
    const app = createUiApp({ upstream: `http://127.0.0.1:${upstream.port}`, version: 'test' })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (server.address() as AddressInfo).port

    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Mindmeld')

    server.close()
  })

  it('answers 502 with the shared error envelope when the API is down', async () => {
    const dead = await startUpstream()
    await new Promise<void>(resolve => dead.server.close(() => resolve()))

    const app = createUiApp({
      upstream: `http://127.0.0.1:${dead.port}`,
      publicDir: await mkdtemp(join(tmpdir(), 'mindmeld-ui-test-')),
      version: 'test',
    })
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (server.address() as AddressInfo).port

    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { status: string; error: string }
    expect(body.status).toBe('error')
    expect(body.error).toContain('unreachable')

    server.close()
  })
})
