import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The server under test. E2E_BASE_URL points the suite at one already running
// (the deployed image, say, to see how trunk behaves); otherwise it starts
// this checkout's server on E2E_PORT and stops it afterwards.
const port = Number(process.env.E2E_PORT ?? 3947)
export const baseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${port}`

let server: ChildProcess | null = null

export const startServer = async () => {
  if (!process.env.E2E_BASE_URL) {
    server = spawn('pnpm', ['exec', 'tsx', 'src/mcp/http-server.ts'], {
      env: { ...process.env, MCP_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const ok = await fetch(`${baseUrl}/health`).then((r) => r.ok, () => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`server at ${baseUrl} never became healthy`)
}

export const stopServer = () => server?.kill('SIGINT')

export type Hit = { sessionId: number; score: number; noiseDamping: number | null; title: string | null }

// A degraded search silently drops its vector arms, and a semantic-only search
// then returns nothing at all -- which would read as "no damping to measure".
// The GPU gate is shared with the ingestion workers, so a busy slot is waited
// out and a search that stays degraded fails the test instead of passing it.
export const search = async (params: Record<string, string | number | boolean>, attempts = 6): Promise<Hit[]> => {
  const url = new URL('/api/search', baseUrl)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now()
    const response = await fetch(url)
    const body = await response.json()
    if (!response.ok) throw new Error(`search failed: ${JSON.stringify(body)}`)
    console.log(`search ${JSON.stringify(params)} -> ${body.count} hits in ${Date.now() - started}ms`)
    if (!body.degraded) return body.results
    console.log(`  degraded (${body.degraded.reason}), attempt ${attempt}/${attempts}`)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  throw new Error(`search stayed degraded after ${attempts} attempts: ${JSON.stringify(params)}`)
}

// reportUselessSession and its undo only exist as MCP tools.
export const mcpTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const client = new Client({ name: 'noise-e2e', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl)))
  const result = await client.callTool({ name, arguments: args })
  await client.close()
  return z.array(z.object({ text: z.string() })).parse(result.content).map((c) => c.text).join('\n')
}

// The MCP search tool's text, retried like search() above: a degraded search
// drops its vector arms and would test the full-text fallback instead.
export const mcpSearch = async (args: Record<string, unknown>, attempts = 6): Promise<string> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const text = await mcpTool('search', args)
    if (!text.includes('full-text results only')) return text
    console.log(`  MCP search degraded, attempt ${attempt}/${attempts}`)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  throw new Error(`MCP search stayed degraded after ${attempts} attempts: ${JSON.stringify(args)}`)
}
