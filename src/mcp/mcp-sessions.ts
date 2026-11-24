import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { TransportRegistry } from './transport-registry.js'

export const mcpSessionHandlers = (
  registry: TransportRegistry<StreamableHTTPServerTransport>,
  getServer: () => McpServer,
) => {
  const sessionNotFound = (res: any) =>
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })

  const post = async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    try {
      let transport: StreamableHTTPServerTransport

      const existing = sessionId ? registry.get(sessionId) : undefined
      if (sessionId && existing) {
        transport = existing
        registry.touch(sessionId)
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            registry.set(id, transport)
          },
          onsessionclosed: (id) => {
            registry.delete(id)
          }
        })

        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) registry.delete(sid)
        }

        const server = getServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      } else if (sessionId) {
        sessionNotFound(res)
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

  const get = async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string
    if (!sessionId) {
      res.status(400).send('Invalid or missing session ID')
      return
    }
    const transport = registry.get(sessionId)
    if (!transport) {
      sessionNotFound(res)
      return
    }
    registry.touch(sessionId)
    await transport.handleRequest(req, res)
  }

  const del = async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string
    if (!sessionId) {
      res.status(400).send('Invalid or missing session ID')
      return
    }
    const transport = registry.get(sessionId)
    if (!transport) {
      sessionNotFound(res)
      return
    }
    try {
      registry.touch(sessionId)
      await transport.handleRequest(req, res)
    } catch (error) {
      console.error('[MCP HTTP] Error handling session termination:', error)
      if (!res.headersSent) res.status(500).send('Error processing session termination')
    }
  }

  return { post, get, delete: del }
}
