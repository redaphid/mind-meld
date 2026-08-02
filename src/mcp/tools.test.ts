import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// The tools are exercised for real against stubbed data access, so the
// handlers themselves are covered — not just the schemas they advertise.
const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => query(...(args as [])),
  closePool: vi.fn(),
  queries: {},
}))

const doSearch = vi.fn(async () => [])
vi.mock('./search.js', () => ({
  search: (...args: unknown[]) => doSearch(...(args as [])),
  formatSearchResults: () => 'SEARCH RESULTS',
  findProjectsByPath: async () => [{ id: 7, name: 'proj' }],
}))

const digest = vi.fn(async () => ({ title: 'a session' }))
vi.mock('./session.js', () => ({
  getSessionDigest: (...args: unknown[]) => digest(...(args as [])),
  getMessages: async () => ({ messages: [] }),
  getMessageById: async () => ({ id: 1 }),
  getChunk: async () => ({ index: 0 }),
  formatDigest: () => 'DIGEST',
  formatMessages: () => 'MESSAGES',
  formatMessage: () => 'MESSAGE',
  formatChunk: () => 'CHUNK',
}))

vi.mock('./health.js', () => ({
  getHealth: async () => ({ coverage: 1 }),
  formatHealth: () => 'HEALTH',
}))

const { createMcpServer } = await import('./tools.js')

// Talk to the server exactly as a real client does, over an in-memory
// transport. This asserts the wire-level surface, not our internals.
const connect = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'parity-test', version: '0.0.0' })
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)])
  return client
}

const advertisedTools = async () => {
  const client = await connect()
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

const text = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0]?.text ?? '')

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

// Advertising a tool is not the same as it working. These call every tool the
// way a client would, so the three that HTTP could not reach are proven to
// actually run — not merely to appear in listTools.
describe('every advertised tool executes', () => {
  it('runs search, and passes includeAutomated through to the search layer', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'anything', includeAutomated: true },
    })
    expect(text(result)).toBe('SEARCH RESULTS')
    expect(doSearch).toHaveBeenCalledWith(expect.objectContaining({ includeAutomated: true }))
    await client.close()
  })

  it('runs health', async () => {
    const client = await connect()
    expect(text(await client.callTool({ name: 'health', arguments: {} }))).toBe('HEALTH')
    await client.close()
  })

  it('runs getSessionTranscript, resolving by search term rather than id', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'getSessionTranscript',
      arguments: { searchTerm: 'some title' },
    })
    expect(text(result)).toBe('DIGEST')
    expect(digest).toHaveBeenCalledWith({ searchTerm: 'some title' })
    await client.close()
  })

  it('reports a missing session as an error rather than an empty digest', async () => {
    digest.mockResolvedValueOnce(null as never)
    const client = await connect()
    const result = await client.callTool({
      name: 'getSessionTranscript',
      arguments: { searchTerm: 'nope' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No session found matching: nope')
    await client.close()
  })

  it('runs the remaining read tools', async () => {
    const client = await connect()
    const calls: [string, Record<string, unknown>, string][] = [
      ['getSession', { sessionId: 1 }, 'DIGEST'],
      ['getMessages', { sessionId: 1 }, 'MESSAGES'],
      ['getMessage', { id: 1 }, 'MESSAGE'],
      ['getChunk', { sessionId: 1, chunkIndex: 0 }, 'CHUNK'],
    ]
    for (const [name, args, expected] of calls)
      expect(text(await client.callTool({ name, arguments: args })), name).toBe(expected)

    expect(text(await client.callTool({ name: 'stats', arguments: {} }))).toContain(
      'Mindmeld Statistics'
    )
    await client.close()
  })

  it('soft-deletes on reportUselessSession, and says so when there was nothing to delete', async () => {
    const client = await connect()

    query.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 } as never)
    expect(
      text(await client.callTool({ name: 'reportUselessSession', arguments: { sessionId: 5 } }))
    ).toBe('Session 5 soft-deleted.')

    // rowCount 0 — already deleted, or never existed.
    expect(
      text(await client.callTool({ name: 'reportUselessSession', arguments: { sessionId: 6 } }))
    ).toContain('not found or already deleted')
    await client.close()
  })

  it('offers the context prompt on both transports, not just stdio', async () => {
    const client = await connect()
    const { prompts } = await client.listPrompts()
    expect(prompts.map(p => p.name)).toContain('context')

    query.mockResolvedValueOnce({
      rows: [{ id: 1, title: 'T', project_name: 'proj', started_at: new Date(), message_count: 3 }],
      rowCount: 1,
    } as never)
    const prompt = await client.getPrompt({ name: 'context', arguments: { cwd: '/w/proj' } })
    expect((prompt.messages[0].content as { text: string }).text).toContain('Previous Conversations')
    await client.close()
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
