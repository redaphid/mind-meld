import assert from 'node:assert'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { query, closePool } from '../db/postgres.js'
import { search, formatSearchResults, findProjectsByPath } from './search.js'
import { getSession, formatSession } from './session.js'

const server = new McpServer({
  name: 'mindmeld',
  version: '0.2.0',
})

server.tool(
  'search',
  `Search past AI conversations using hybrid full-text + semantic search.

BEST FOR:
- Finding previous discussions about a topic
- Discovering how you solved similar problems before
- Finding code patterns you've used
- Recalling tool usage and workflows

CWD-AWARE:
- Pass your current working directory to prioritize conversations from that project
- Results from the current project are boosted in relevance

SEARCH MODES:
- semantic: Find conceptually similar content (default)
- text: Exact phrase/keyword matching
- hybrid: Combines both approaches

WEIGHTED CENTROID SEARCH:
- likeSession: Boost results similar to specific session(s) style
  Format: ["123"] or ["123:1.5"] for weighted boost
- unlikeSession: Suppress results similar to specific session(s)
- likeProject: Boost results matching specific project(s) topics
- unlikeProject: Suppress results matching these project(s)

Weight scale: 0.3-0.5 (gentle), 1.0 (default), 1.2-1.5 (strong), 2.0+ (aggressive)`,
  {
    query: z.string().optional().describe('Search query - natural language works best for semantic search (optional when using centroid params)'),
    negativeQuery: z.string().optional().describe('Negative query - pushes results away from this concept'),
    excludeTerms: z.string().optional().describe('Hard filter - exclude results containing these terms'),
    cwd: z.string().optional().describe('Current working directory - conversations from matching projects get boosted'),
    mode: z.enum(['semantic', 'text', 'hybrid']).optional().describe('Search mode: semantic (default), text, or hybrid'),
    limit: z.number().optional().describe('Max results to return (default 20)'),
    source: z.string().optional().describe('Filter to specific source'),
    since: z.string().optional().describe('Only include conversations since this time (e.g., "7d", "2024-01-01")'),
    projectOnly: z.boolean().optional().describe('Only search conversations from the CWD project'),
    likeSession: z.array(z.string()).optional().describe('Boost results similar to these session IDs (format: ["123"] or ["123:1.5"])'),
    unlikeSession: z.array(z.string()).optional().describe('Suppress results similar to these session IDs'),
    likeProject: z.array(z.string()).optional().describe('Boost results matching these project IDs'),
    unlikeProject: z.array(z.string()).optional().describe('Suppress results matching these project IDs'),
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
  `Get a conversation session by ID. Returns session metadata, summary, and all messages.

Use after search to dive deep into a relevant conversation.
Pagination is optional — omit offset/limit to get the entire thread.`,
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
  'getSessionTranscript',
  `Get a session by external ID or title search.

Searches by exact external_id match first, then falls back to ILIKE title search.
Returns session metadata, summary, and all messages.`,
  {
    searchTerm: z.string().describe('Session external_id or title search term'),
    offset: z.number().optional().describe('Start at this message index (0-based)'),
    limit: z.number().optional().describe('Number of messages to return'),
  },
  async (params) => {
    const result = await getSession({ searchTerm: params.searchTerm, offset: params.offset, limit: params.limit })
    if (!result) return { content: [{ type: 'text', text: `No session found matching: ${params.searchTerm}` }], isError: true }
    return { content: [{ type: 'text', text: formatSession(result) }] }
  }
)

server.prompt(
  'context',
  'Find relevant past conversations for your current project',
  {
    cwd: z.string().describe('Your current working directory'),
    task: z.string().optional().describe('Brief description of what you\'re working on'),
  },
  async (params) => {
    const projects = await findProjectsByPath(params.cwd)

    if (projects.length === 0) {
      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: `No previous conversations found for ${params.cwd}. This appears to be a new project.` },
        }],
      }
    }

    const projectIds = projects.map((p) => p.id)

    const recentResult = await query<{
      id: number
      title: string
      project_name: string
      started_at: Date
      message_count: number
    }>(
      `SELECT s.id, s.title, p.name as project_name, s.started_at, s.message_count
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       WHERE p.id = ANY($1::int[]) AND s.deleted_at IS NULL
       ORDER BY s.started_at DESC
       LIMIT 10`,
      [projectIds]
    )

    let contextText = `# Previous Conversations for ${projects[0].name}\n\n`
    contextText += `**Path:** ${params.cwd}\n\n`
    if (params.task) contextText += `**Current task:** ${params.task}\n\n`
    contextText += `## Recent Sessions\n\n`

    for (const session of recentResult.rows) {
      assert(session.started_at, `Missing started_at for session ${session.id}`)
      contextText += `- **${session.title ?? 'Untitled'}** (${session.started_at.toISOString().split('T')[0]}) - ${session.message_count} messages [ID: ${session.id}]\n`
    }

    contextText += `\n---\n\nUse the \`search\` tool with your current task description to find more specific relevant conversations.`

    return {
      messages: [{ role: 'user', content: { type: 'text', text: contextText } }],
    }
  }
)

server.tool(
  'stats',
  'Get statistics about your conversation history',
  {},
  async () => {
    const stats = await query<{
      source_name: string
      project_count: number
      session_count: number
      message_count: number
    }>(
      `SELECT src.name as source_name,
              COUNT(DISTINCT p.id) as project_count,
              COUNT(DISTINCT s.id) as session_count,
              COUNT(m.id) as message_count
       FROM sources src
       LEFT JOIN projects p ON p.source_id = src.id
       LEFT JOIN sessions s ON s.project_id = p.id
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY src.name`
    )

    const topProjects = await query<{
      name: string
      session_count: number
      message_count: number
    }>(
      `SELECT p.name, COUNT(DISTINCT s.id) as session_count, COUNT(m.id) as message_count
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY p.id, p.name
       ORDER BY session_count DESC
       LIMIT 10`
    )

    let output = `# Mindmeld Statistics\n\n## By Source\n\n`
    for (const row of stats.rows)
      output += `**${row.source_name}:** ${row.project_count} projects, ${row.session_count} sessions, ${row.message_count} messages\n`

    output += `\n## Top Projects\n\n`
    for (const row of topProjects.rows)
      output += `- **${row.name}:** ${row.session_count} sessions, ${row.message_count} messages\n`

    return { content: [{ type: 'text', text: output }] }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', async () => {
  await closePool()
  process.exit(0)
})
