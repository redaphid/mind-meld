import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { query, closePool } from '../db/postgres.js'

const getServer = () => {
  const server = new McpServer({
    name: 'mindmeld',
    version: '0.1.0',
  })

  // Register search tool (simplified - full implementation in server.ts)
  server.tool(
    'search',
    'Search past AI conversations',
    {
      query: z.string(),
      limit: z.number().optional(),
    },
    async (params) => {
      // Stub implementation - full version in server.ts
      return {
        content: [{
          type: 'text',
          text: `Search for: ${params.query} (HTTP server - stub implementation)`,
        }],
      }
    }
  )

  // Register getSession tool
  server.tool(
    'getSession',
    'Get full conversation session',
    {
      sessionId: z.number(),
      messageLimit: z.number().optional(),
    },
    async (params) => {
      const limit = params.messageLimit ?? 50

      const sessionResult = await query<{
        id: number
        title: string
        message_count: number
      }>(
        `SELECT id, title, message_count FROM sessions WHERE id = $1`,
        [params.sessionId]
      )

      if (!sessionResult.rows[0]) {
        return { content: [{ type: 'text', text: 'Session not found.' }] }
      }

      return {
        content: [{
          type: 'text',
          text: `Session: ${sessionResult.rows[0].title} (${sessionResult.rows[0].message_count} messages)`,
        }],
      }
    }
  )

  // Register stats tool
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
      for (const row of stats.rows) {
        output += `**${row.source_name}:** ${row.session_count} sessions\n`
      }

      return { content: [{ type: 'text', text: output }] }
    }
  )

  return server
}

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000

const app = createMcpExpressApp()

// Map to store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {}

// MCP POST endpoint
const mcpPostHandler = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined

  if (sessionId) {
    console.log(`[MCP HTTP] Request for session: ${sessionId}`)
  } else {
    console.log('[MCP HTTP] New connection request')
  }

  try {
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId]
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          console.log(`[MCP HTTP] Session initialized: ${id}`)
          transports[id] = transport
        },
        onsessionclosed: (id) => {
          console.log(`[MCP HTTP] Session closed: ${id}`)
          delete transports[id]
        }
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid && transports[sid]) {
          console.log(`[MCP HTTP] Transport closed for session ${sid}`)
          delete transports[sid]
        }
      }

      // Connect server to transport
      const server = getServer()
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided'
        },
        id: null
      })
      return
    }

    // Handle request with existing transport
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('[MCP HTTP] Error handling request:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      })
    }
  }
}

// MCP GET endpoint (for SSE streams)
const mcpGetHandler = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID')
    return
  }

  const lastEventId = req.headers['last-event-id']
  if (lastEventId) {
    console.log(`[MCP HTTP] Client reconnecting with Last-Event-ID: ${lastEventId}`)
  } else {
    console.log(`[MCP HTTP] New SSE stream for session ${sessionId}`)
  }

  const transport = transports[sessionId]
  await transport.handleRequest(req, res)
}

// MCP DELETE endpoint (session termination)
const mcpDeleteHandler = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID')
    return
  }

  console.log(`[MCP HTTP] Session termination request: ${sessionId}`)

  try {
    const transport = transports[sessionId]
    await transport.handleRequest(req, res)
  } catch (error) {
    console.error('[MCP HTTP] Error handling session termination:', error)
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination')
    }
  }
}

// Register routes
app.post('/mcp', mcpPostHandler)
app.get('/mcp', mcpGetHandler)
app.delete('/mcp', mcpDeleteHandler)

// Health check endpoint
app.get('/health', (req: any, res: any) => {
  res.json({ status: 'ok', name: 'mindmeld', version: '0.1.0' })
})

// Start server
app.listen(MCP_PORT, () => {
  console.log(`[MCP HTTP] Mindmeld server listening on http://localhost:${MCP_PORT}`)
  console.log(`[MCP HTTP] Endpoint: http://localhost:${MCP_PORT}/mcp`)
  console.log(`[MCP HTTP] Health: http://localhost:${MCP_PORT}/health`)
})

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('[MCP HTTP] Shutting down...')

  // Close all transports
  for (const sessionId in transports) {
    try {
      console.log(`[MCP HTTP] Closing transport for session ${sessionId}`)
      await transports[sessionId].close()
      delete transports[sessionId]
    } catch (error) {
      console.error(`[MCP HTTP] Error closing transport ${sessionId}:`, error)
    }
  }

  // Close database pool
  await closePool()

  console.log('[MCP HTTP] Shutdown complete')
  process.exit(0)
})
