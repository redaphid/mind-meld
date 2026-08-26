import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// The tool calls the diagnostics-carrying form, so a degraded search can say so
// in the text it hands back to an LLM.
const doSearch = vi.fn(async () => ({ results: [], degraded: null }))
const findProjectsByPath = vi.fn(async () => [{ id: 7, name: 'proj' }])
vi.mock('./search.js', () => ({
  searchWithDiagnostics: (...args: unknown[]) => doSearch(...(args as [])),
  formatSearchResults: () => 'SEARCH RESULTS',
  findProjectsByPath: (...args: unknown[]) => findProjectsByPath(...(args as [])),
}))

const digest = vi.fn(async () => ({ title: 'a session' }))
const messages = vi.fn(async () => ({ messages: [] }))
const messageById = vi.fn(async () => ({ id: 1 }))
const chunk = vi.fn(async () => ({ index: 0 }))
vi.mock('./session.js', () => ({
  getSessionDigest: (...args: unknown[]) => digest(...(args as [])),
  getMessages: (...args: unknown[]) => messages(...(args as [])),
  getMessageById: (...args: unknown[]) => messageById(...(args as [])),
  getChunk: (...args: unknown[]) => chunk(...(args as [])),
  formatDigest: () => 'DIGEST',
  formatMessages: () => 'MESSAGES',
  formatMessage: () => 'MESSAGE',
  formatChunk: () => 'CHUNK',
}))

vi.mock('./health.js', () => ({
  getHealth: async () => ({ coverage: 1 }),
  formatHealth: () => 'HEALTH',
}))

const doApplyTags = vi.fn(async () => ['useless'])
const doRemoveTags = vi.fn(async () => ['useless'])
const doGetTags = vi.fn(async () => ['useless'])
vi.mock('./tags.js', () => ({
  applyTags: (...args: unknown[]) => doApplyTags(...(args as [])),
  removeTags: (...args: unknown[]) => doRemoveTags(...(args as [])),
  getTags: (...args: unknown[]) => doGetTags(...(args as [])),
  formatTagWrite: () => 'TAG WRITE',
  defaultExcludedTags: () => ['useless'],
}))

const doWriteNote = vi.fn(async () => ({ sessionId: 42, title: 'a note', dataClass: 'notes', tags: ['note'] }))
vi.mock('./notes.js', () => ({
  writeNote: (...args: unknown[]) => doWriteNote(...(args as [])),
  formatWrittenNote: () => 'WRITTEN NOTE',
  NOTE_TAG: 'note',
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

// Call history only — the default implementations above must survive.
beforeEach(() => {
  vi.clearAllMocks()
})

const src = (file: string) =>
  readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

// Every tool both transports must offer. A tool added to the shared module
// without being listed here fails too — the list is the reviewed contract.
const EXPECTED_TOOLS = [
  'addTag',
  'getChunk',
  'getMessage',
  'getMessages',
  'getSession',
  'getSessionTranscript',
  'health',
  'removeTag',
  'reportUselessSession',
  'search',
  'stats',
  'writeNote',
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

    await client.close()
  })

  it('aggregates stats by source, by data class, and by project', async () => {
    // Two sources sharing a data class, so the per-class rollup has something
    // to actually add up.
    query
      .mockResolvedValueOnce({
        rows: [
          { source_name: 'claude_code', data_class: 'coding', project_count: 4, session_count: 10, message_count: 900 },
          { source_name: 'slack', data_class: 'coding', project_count: 1, session_count: 5, message_count: 80 },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ name: 'mind-meld', session_count: 7, message_count: 500 }],
        rowCount: 1,
      } as never)

    const client = await connect()
    const out = text(await client.callTool({ name: 'stats', arguments: {} }))
    expect(out).toContain('**claude_code** (coding): 4 projects, 10 sessions, 900 messages')
    expect(out).toContain('**coding:** 15 sessions')
    expect(out).toContain('- **mind-meld:** 7 sessions, 500 messages')
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

  it('routes addTag to a session or a message, and refuses anything ambiguous', async () => {
    const client = await connect()

    expect(text(await client.callTool({ name: 'addTag', arguments: { sessionId: 5, tag: 'Useless' } })))
      .toBe('TAG WRITE')
    expect(doApplyTags).toHaveBeenCalledWith({ sessionId: 5 }, ['Useless'], { createdBy: 'mcp', note: undefined })

    // Message granularity is equally valid — the tool must not force sessions.
    await client.callTool({ name: 'addTag', arguments: { messageId: 99, tags: ['a', 'b'] } })
    expect(doApplyTags).toHaveBeenLastCalledWith({ messageId: 99 }, ['a', 'b'], { createdBy: 'mcp', note: undefined })

    // `tag` and `tags` are one list, so a caller never has to choose a form.
    await client.callTool({ name: 'addTag', arguments: { sessionId: 5, tag: 'a', tags: ['b'] } })
    expect(doApplyTags).toHaveBeenLastCalledWith({ sessionId: 5 }, ['a', 'b'], { createdBy: 'mcp', note: undefined })

    // Naming both targets, or neither, is a mistake worth reporting rather
    // than a coin flip about what the caller meant.
    for (const args of [{ sessionId: 5, messageId: 9, tag: 'x' }, { tag: 'x' }]) {
      const result = await client.callTool({ name: 'addTag', arguments: args })
      expect((result as { isError?: boolean }).isError).toBe(true)
    }

    // A target with no tag is likewise refused, not silently accepted.
    const empty = await client.callTool({ name: 'addTag', arguments: { sessionId: 5 } })
    expect((empty as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it('routes removeTag the same way, so tagging is reversible', async () => {
    const client = await connect()
    expect(text(await client.callTool({ name: 'removeTag', arguments: { sessionId: 5, tag: 'useless' } })))
      .toBe('TAG WRITE')
    expect(doRemoveTags).toHaveBeenCalledWith({ sessionId: 5 }, ['useless'])
    await client.close()
  })

  it('advertises tag filtering on search, including the hidden-tag escape hatch', async () => {
    const search = (await advertisedTools()).find(t => t.name === 'search')!
    const properties = (search.inputSchema as { properties: Record<string, unknown> }).properties
    // Without both halves, a default-excluded tag is a one-way door: things go
    // in and can never be searched for again.
    expect(properties).toHaveProperty('tags')
    expect(properties).toHaveProperty('excludeTags')
  })

  it('passes tag filters through to the search layer untouched', async () => {
    const client = await connect()
    await client.callTool({
      name: 'search',
      arguments: { query: 'x', tags: ['keeper'], excludeTags: ['noise'] },
    })
    expect(doSearch).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['keeper'], excludeTags: ['noise'] })
    )
    await client.close()
  })

  it('runs writeNote, passing text, title and tags through to the notes layer', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'writeNote',
      arguments: { text: 'remember this', title: 'Reminder', tags: ['decision'] },
    })
    expect(text(result)).toBe('WRITTEN NOTE')
    expect(doWriteNote).toHaveBeenCalledWith({
      text: 'remember this',
      title: 'Reminder',
      tags: ['decision'],
    })
    await client.close()
  })

  // The automatic "note" tag is applied in the notes layer, not here, so the
  // tool must NOT accept it as an argument or pre-seed it — otherwise a caller
  // could reasonably think it was optional.
  it('offers tags on writeNote without asking the caller to supply the automatic one', async () => {
    const write = (await advertisedTools()).find(t => t.name === 'writeNote')!
    const properties = (write.inputSchema as { properties: Record<string, unknown> }).properties
    expect(properties).toHaveProperty('tags')

    const client = await connect()
    await client.callTool({ name: 'writeNote', arguments: { text: 'no tags given' } })
    expect(doWriteNote).toHaveBeenLastCalledWith({ text: 'no tags given', title: undefined, tags: undefined })
    await client.close()
  })

  // Task 329 renamed this tool from the earlier unmerged `saveNote` draft.
  // Two names for one write path is the failure worth guarding against: an
  // LLM would have no way to tell which one to reach for.
  it('offers exactly one note-writing tool, not both names', async () => {
    const names = (await advertisedTools()).map(t => t.name)
    expect(names).toContain('writeNote')
    expect(names).not.toContain('saveNote')
  })

  it('only resolves cwd to projects when a cwd was given', async () => {
    const client = await connect()

    await client.callTool({ name: 'search', arguments: { query: 'x' } })
    expect(findProjectsByPath).not.toHaveBeenCalled()

    await client.callTool({ name: 'search', arguments: { query: 'x', cwd: '/w/proj' } })
    expect(findProjectsByPath).toHaveBeenCalledWith('/w/proj')
    await client.close()
  })

  it('says so, rather than failing, when a lookup finds nothing', async () => {
    digest.mockResolvedValueOnce(null as never)
    messages.mockResolvedValueOnce(null as never)
    messageById.mockResolvedValueOnce(null as never)
    chunk.mockResolvedValueOnce(null as never)

    const client = await connect()
    const misses: [string, Record<string, unknown>, string][] = [
      ['getSession', { sessionId: 1 }, 'Session not found.'],
      ['getMessages', { sessionId: 1 }, 'No messages found.'],
      ['getMessage', { id: 1 }, 'Message not found.'],
      ['getChunk', { sessionId: 1, chunkIndex: 0 }, 'Chunk not found.'],
    ]
    for (const [name, args, expected] of misses)
      expect(text(await client.callTool({ name, arguments: args })), name).toBe(expected)
    await client.close()
  })

  it('logs the reason when reportUselessSession is given one', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    query.mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 } as never)

    const client = await connect()
    await client.callTool({
      name: 'reportUselessSession',
      arguments: { sessionId: 9, reason: 'automated monitoring noise' },
    })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('automated monitoring noise'))
    stderr.mockRestore()
    await client.close()
  })

  it('tells the context prompt apart from a project with no history', async () => {
    findProjectsByPath.mockResolvedValueOnce([])
    const client = await connect()
    const prompt = await client.getPrompt({ name: 'context', arguments: { cwd: '/w/new' } })
    expect((prompt.messages[0].content as { text: string }).text).toContain(
      'This appears to be a new project'
    )
    await client.close()
  })

  it('offers the context prompt on both transports, not just stdio', async () => {
    const client = await connect()
    const { prompts } = await client.listPrompts()
    expect(prompts.map(p => p.name)).toContain('context')

    query.mockResolvedValueOnce({
      rows: [
        { id: 1, title: 'T', summary: null, project_name: 'proj', started_at: new Date(), message_count: 3 },
        // A session with no stored title takes one from its summary (#95).
        { id: 2, title: null, summary: 'Wired the parity fix. Then went home.', project_name: 'proj', started_at: new Date(), message_count: 1 },
        // With neither, it must still render a line, not a blank -- but an
        // honest placeholder rather than a fabricated topic.
        { id: 3, title: null, summary: null, project_name: 'proj', started_at: new Date(), message_count: 1 },
      ],
      rowCount: 3,
    } as never)
    const prompt = await client.getPrompt({
      name: 'context',
      arguments: { cwd: '/w/proj', task: 'wiring up the parity fix' },
    })
    const body = (prompt.messages[0].content as { text: string }).text
    expect(body).toContain('Previous Conversations')
    expect(body).toContain('wiring up the parity fix')
    expect(body).toContain('Wired the parity fix.')
    expect(body).not.toContain('Then went home.')
    expect(body).toContain('Session 3 (no title — not summarized yet)')
    expect(body).not.toContain('Untitled')
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
