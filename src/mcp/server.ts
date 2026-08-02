import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { closePool } from '../db/postgres.js'
import { createMcpServer } from './tools.js'

// The stdio transport. The tool surface itself lives in ./tools.js and is
// shared with the Streamable HTTP transport (http-server.ts) — deliberately
// nothing is declared here, so the two can never drift apart again.
const server = createMcpServer()

const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', async () => {
  await closePool()
  process.exit(0)
})