import { randomUUID } from 'node:crypto'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { query, closePool, queries } from '../db/postgres.js'
import { runMigrations } from '../db/migrations.js'
import { search, formatSearchResults, findProjectsByPath } from './search.js'
import { getSession, formatSession } from './session.js'
import { getSyncStatus } from '../sync/orchestrator.js'
import { getCollectionStats } from '../db/chroma.js'
import { config } from '../config.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

const IngestMessageSchema = z.object({
  externalId: z.string(),
  role: z.string(),
  content: z.string(),
  timestamp: z.string().transform(s => new Date(s)),
  sequenceNum: z.number(),
  metadata: z.record(z.unknown()).optional(),
})

const IngestPayloadSchema = z.object({
  source: z.string(),
  sourceDisplayName: z.string().optional(),
  project: z.object({
    externalId: z.string(),
    name: z.string(),
    path: z.string().optional(),
  }),
  session: z.object({
    externalId: z.string(),
    title: z.string(),
    startedAt: z.string().transform(s => new Date(s)),
    endedAt: z.string().transform(s => new Date(s)).optional(),
  }),
  messages: z.array(IngestMessageSchema),
})

const getServer = () => {
  const server = new McpServer({
    name: 'mindmeld',
    version: '0.2.0',
  })

  server.tool(
    'search',
    'Search past AI conversations',
    {
      query: z.string().optional(),
      negativeQuery: z.string().optional(),
      excludeTerms: z.string().optional(),
      limit: z.number().optional(),
      cwd: z.string().optional(),
      mode: z.enum(['semantic', 'text', 'hybrid']).optional(),
      source: z.string().optional(),
      since: z.string().optional(),
      projectOnly: z.boolean().optional(),
      likeSession: z.array(z.string()).optional(),
      unlikeSession: z.array(z.string()).optional(),
      likeProject: z.array(z.string()).optional(),
      unlikeProject: z.array(z.string()).optional(),
    },
    async (params) => {
      const matchingProjects = params.cwd ? await findProjectsByPath(params.cwd) : []
      const projectIds = matchingProjects.map((p) => p.id)
      const results = await search(params)
      return {
        content: [{ type: 'text', text: formatSearchResults(results, projectIds) }],
      }
    }
  )

  server.tool(
    'getSession',
    'Get conversation session by ID. Returns metadata, summary, and all messages. Optional offset/limit for pagination.',
    {
      sessionId: z.number().describe('Session ID from search results'),
      offset: z.number().optional().describe('Start at this message index (0-based)'),
      limit: z.number().optional().describe('Number of messages to return'),
    },
    async (params) => {
      const result = await getSession(params)
      if (!result) return { content: [{ type: 'text', text: 'Session not found.' }] }
      return { content: [{ type: 'text', text: formatSession(result) }] }
    }
  )

  server.tool(
    'stats',
    'Get conversation statistics',
    {},
    async () => {
      const stats = await query<{
        source_name: string
        session_count: number
      }>(
        `SELECT src.name as source_name, COUNT(DISTINCT s.id) as session_count
         FROM sources src
         LEFT JOIN projects p ON p.source_id = src.id
         LEFT JOIN sessions s ON s.project_id = p.id
         GROUP BY src.name`
      )

      let output = `# Mindmeld Statistics\n\n`
      for (const row of stats.rows)
        output += `**${row.source_name}:** ${row.session_count} sessions\n`

      return { content: [{ type: 'text', text: output }] }
    }
  )

  return server
}

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000

const app = express()
app.use(hostHeaderValidation(['localhost', '127.0.0.1', 'mcp']))
app.use(express.json({ limit: '10mb' }))

const transports: Record<string, StreamableHTTPServerTransport> = {}

const mcpPostHandler = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined

  try {
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId]
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport
        },
        onsessionclosed: (id) => {
          delete transports[id]
        }
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid && transports[sid]) delete transports[sid]
      }

      const server = getServer()
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      })
      return
    }

    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('[MCP HTTP] Error handling request:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      })
    }
  }
}

const mcpGetHandler = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID')
    return
  }
  await transports[sessionId].handleRequest(req, res)
}

const mcpDeleteHandler = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID')
    return
  }
  try {
    await transports[sessionId].handleRequest(req, res)
  } catch (error) {
    console.error('[MCP HTTP] Error handling session termination:', error)
    if (!res.headersSent) res.status(500).send('Error processing session termination')
  }
}

app.post('/mcp', mcpPostHandler)
app.get('/mcp', mcpGetHandler)
app.delete('/mcp', mcpDeleteHandler)

app.get('/health', (req: any, res: any) => {
  res.json({ status: 'ok', name: 'mindmeld', version })
})

app.get('/status', async (req: any, res: any) => {
  try {
    const syncStatus = await getSyncStatus()

    const recentlyProcessed = await query<{
      id: number
      title: string
      project: string
      last_synced_at: string
      message_count: number
    }>(`
      SELECT s.id, LEFT(s.title, 100) as title, p.name as project,
             s.last_synced_at, s.message_count
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.last_synced_at > NOW() - INTERVAL '10 minutes'
        AND s.deleted_at IS NULL
      ORDER BY s.last_synced_at DESC
      LIMIT 10
    `)

    const pendingMessages = await query<{ count: string }>(`
      SELECT COUNT(*) as count FROM messages m
      LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
      WHERE m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10 AND e.id IS NULL
    `)

    const pendingSessions = await query<{ count: string }>(`
      SELECT COUNT(*) as count FROM sessions s
      LEFT JOIN embeddings e ON e.chroma_collection = 'convo-sessions' AND e.chroma_id = 'session-' || s.id::text
      WHERE s.deleted_at IS NULL
        AND s.message_count > 0
        AND (e.id IS NULL OR s.content_chars > COALESCE(e.content_chars_at_embed, 0))
    `)

    const latestSession = await query<{
      started_at: string
      title: string
      project: string
    }>(`
      SELECT s.started_at, s.title, p.name as project
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.deleted_at IS NULL
        AND s.title NOT ILIKE '%briefing%'
      ORDER BY s.started_at DESC
      LIMIT 1
    `)

    let chromaCollections: { name: string, count: number }[] = []
    try {
      const collectionNames = Object.values(config.chroma.collections)
      chromaCollections = await Promise.all(
        collectionNames.map(name => getCollectionStats(name))
      )
    } catch {
      // Chroma unavailable
    }

    const latest = latestSession.rows[0]

    res.json({
      status: 'ok',
      version,
      sync: {
        sources: syncStatus.sources,
        recentlyProcessed: recentlyProcessed.rows.map(r => ({
          sessionId: r.id,
          title: r.title,
          project: r.project,
          lastSyncedAt: r.last_synced_at,
          messageCount: r.message_count,
        })),
      },
      totals: syncStatus.totals,
      pendingEmbeddings: {
        messages: parseInt(pendingMessages.rows[0]?.count ?? '0', 10),
        sessions: parseInt(pendingSessions.rows[0]?.count ?? '0', 10),
      },
      chroma: { collections: chromaCollections },
      latestSession: latest
        ? { startedAt: latest.started_at, title: latest.title, project: latest.project }
        : null,
    })
  } catch (error) {
    console.error('[API] Status error:', error)
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/ingest', async (req: any, res: any) => {
  try {
    const payload = IngestPayloadSchema.parse(req.body)

    const source = await queries.getOrCreateSource(payload.source, payload.sourceDisplayName)

    const projectId = await queries.upsertProject(
      source.id,
      payload.project.externalId,
      payload.project.path ?? '',
      payload.project.name
    )

    const sessionId = await queries.upsertSession({
      projectId,
      externalId: payload.session.externalId,
      title: payload.session.title,
      startedAt: payload.session.startedAt,
      endedAt: payload.session.endedAt,
    })

    let messagesInserted = 0
    for (const msg of payload.messages) {
      const msgId = await queries.insertMessage({
        sessionId,
        externalId: msg.externalId,
        role: msg.role,
        contentText: msg.content,
        contentJson: msg.metadata,
        timestamp: msg.timestamp,
        sequenceNum: msg.sequenceNum,
      })
      if (msgId) messagesInserted++
    }

    await queries.updateSessionStats(sessionId)

    res.json({ success: true, sourceId: source.id, projectId, sessionId, messagesInserted })
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation failed', details: error.errors })
      return
    }
    console.error('[API] Ingest error:', error)
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

const start = async () => {
  await runMigrations()

  app.listen(MCP_PORT, () => {
    console.log(`[MCP HTTP] Mindmeld server listening on http://localhost:${MCP_PORT}`)
  })
}

start().catch(error => {
  console.error('[MCP HTTP] Failed to start:', error)
  process.exit(1)
})

process.on('SIGINT', async () => {
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close()
      delete transports[sessionId]
    } catch (error) {
      console.error(`[MCP HTTP] Error closing transport ${sessionId}:`, error)
    }
  }
  await closePool()
  process.exit(0)
})
