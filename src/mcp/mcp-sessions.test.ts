import assert from 'node:assert'
import type { Server } from 'node:http'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TransportRegistry } from './transport-registry.js'
import { mcpSessionHandlers } from './mcp-sessions.js'

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const unknownSessionId = 'session-id-valley-of-the-sun'

describe('MCP session handlers', () => {
  let now: number
  let registry: TransportRegistry<StreamableHTTPServerTransport>
  let server: Server
  let url: string

  const initialize = async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'client-the-rusty-conquistador', version: '1' } },
      }),
    })
    await res.text()
    return res.headers.get('mcp-session-id')!
  }

  const ping = async (sessionId?: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    })
    return { status: res.status, body: await res.text() }
  }

  beforeEach(async () => {
    now = 0
    registry = new TransportRegistry(1_000, () => now)
    const mcp = mcpSessionHandlers(registry, () => new McpServer({ name: 'server-thunderwrench', version: '1.0.0' }))
    const app = express()
    app.use(express.json())
    app.post('/mcp', mcp.post)
    app.get('/mcp', mcp.get)
    app.delete('/mcp', mcp.delete)
    server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    url = `http://127.0.0.1:${address.port}/mcp`
  })

  afterEach(async () => {
    await registry.closeAll()
    await new Promise(resolve => server.close(resolve))
  })

  describe('when one session keeps calling and another goes quiet past the idle limit', () => {
    let activeId: string
    let idleId: string
    let active: { status: number }
    let idle: { status: number; body: string }

    beforeEach(async () => {
      activeId = await initialize()
      idleId = await initialize()
      now = 900
      await ping(activeId)
      now = 1_000
      await registry.expireIdle()
      active = await ping(activeId)
      idle = await ping(idleId)
    })

    it('should keep serving the active session', () => {
      expect(active.status).toBe(200)
    })

    it('should answer the idle session with 404 so the client re-initializes', () => {
      expect(idle.status).toBe(404)
    })

    it('should say the idle session was not found', () => {
      expect(JSON.parse(idle.body).error.message).toBe('Session not found')
    })

    it('should retain only the active session', () => {
      expect(registry.size()).toBe(1)
    })
  })

  describe('when a client ends its session with DELETE', () => {
    let deleted: Response
    let after: { status: number }

    beforeEach(async () => {
      const sessionId = await initialize()
      deleted = await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sessionId } })
      after = await ping(sessionId)
    })

    it('should accept the DELETE', () => {
      expect(deleted.status).toBe(200)
    })

    it('should answer later requests on that session with 404', () => {
      expect(after.status).toBe(404)
    })
  })

  describe('when a request names a session the server does not hold', () => {
    let statuses: number[]

    beforeEach(async () => {
      const sessionHeaders = { 'mcp-session-id': unknownSessionId }
      statuses = [
        (await ping(unknownSessionId)).status,
        (await fetch(url, { headers: sessionHeaders })).status,
        (await fetch(url, { method: 'DELETE', headers: sessionHeaders })).status,
      ]
    })

    it('should answer POST, GET and DELETE with 404', () => {
      expect(statuses).toEqual([404, 404, 404])
    })
  })

  describe('when a request carries no session id', () => {
    let statuses: number[]

    beforeEach(async () => {
      statuses = [
        (await ping()).status,
        (await fetch(url)).status,
        (await fetch(url, { method: 'DELETE' })).status,
      ]
    })

    it('should answer POST, GET and DELETE with 400', () => {
      expect(statuses).toEqual([400, 400, 400])
    })
  })
})
