import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// Nothing here executes a tool — we only inspect the advertised surface — but
// importing the tool module pulls in the db layer, so it is stubbed.
vi.mock('../db/postgres.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: vi.fn(),
  queries: {},
}))

const { createMcpServer } = await import('./tools.js')

// Ask the server what it advertises the same way a real client does, over an
// in-memory transport. This asserts the wire-level surface, not our internals.
const advertisedTools = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'parity-test', version: '0.0.0' })
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)])
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

const src = (file: string) =>
  readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

// Every tool both transports must offer. A tool added to the shared module
// without being listed here fails too — the list is the reviewed contract.
const EXPECTED_TOOLS = [
  'getChunk',
  'getMessage',
  'getMessages',
  'getSession',
  'getSessionTranscript',
  'health',
  'reportUselessSession',
  'search',
  'stats',
]

describe('shared MCP tool surface', () => {
  it('advertises exactly the expected tools', async () => {
    const names = (await advertisedTools()).map(t => t.name).sort()
    expect(names).toEqual(EXPECTED_TOOLS)
  })

  it('exposes includeAutomated on search', async () => {
    const search = (await advertisedTools()).find(t => t.name === 'search')
    // Automated sessions are excluded by default, so without this parameter
    // they are indexed but completely unreachable.
    expect(Object.keys(search!.inputSchema.properties ?? {})).toContain('includeAutomated')
  })

  it('gives every tool a description, and search the full progressive-disclosure guidance', async () => {
    const tools = await advertisedTools()
    for (const tool of tools) expect(tool.description ?? '', tool.name).not.toHaveLength(0)

    // Tool descriptions are the LLM's API documentation. `search` is the entry
    // point to the three-tier drill-down, and a one-liner strands the caller.
    const search = tools.find(t => t.name === 'search')!.description ?? ''
    expect(search).toContain('matched_tier')
    expect(search).toContain('cursor')
    expect(search).toContain('getMessages')
    expect(search.length).toBeGreaterThan(500)
  })
})

// The stdio and HTTP servers drifted (missing `health`, missing
// `getSessionTranscript`, missing `includeAutomated`, descriptions decayed to
// one-liners) because each hand-wrote the same tools. These tests fail the
// moment anyone reintroduces a hand-written definition in either transport,
// which is the only durable fix.
describe('neither transport declares tools of its own', () => {
  it.each(['./server.ts', './http-server.ts'])('%s registers nothing inline', async file => {
    const text = await src(file)
    expect(text).not.toMatch(/\.tool\s*\(/)
    expect(text).not.toMatch(/\.prompt\s*\(/)
  })

  it.each(['./server.ts', './http-server.ts'])('%s builds its server from tools.ts', async file => {
    expect(await src(file)).toMatch(/from '\.\/tools\.js'/)
  })
})
