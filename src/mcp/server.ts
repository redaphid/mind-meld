import assert from 'node:assert'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { query, closePool } from '../db/postgres.js'
import { search, formatSearchResults, findProjectsByPath } from './search.js'
import { sinceSchema } from './since.js'
import {
  getSessionDigest,
  getMessages,
  getMessageById,
  getChunk,
  formatDigest,
  formatMessages,
  formatMessage,
  formatChunk,
} from './session.js'
import { getHealth, formatHealth } from './health.js'

const server = new McpServer({
  name: 'mindmeld',
  version: '0.2.0',
})

server.tool(
  'search',
  `Search past AI conversations. Returns TERSE ranked hits — one line each, no
full summaries — so you can triage cheaply, then drill in.

Each hit carries:
- session_id, title, date, score
- matched_tier: which rung matched (session | chunk | message)
- snippet: the query-highlighted lead of the matched region
- cursor (optional): deep-link into the match — { chunk_index } or { message_id }

Searches THREE tiers (session summaries, chunk summaries, per-message vectors)
and fuses them. After a hit:
- getSession(session_id) → digest + chunk map, then getMessages(chunk range)
- OR jump straight to getMessages around cursor.message_id, skipping the digest.

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
    limit: z.number().optional().describe('Max results to return (default 8)'),
    source: z.string().optional().describe('Filter to specific source'),
    since: sinceSchema.optional(),
    projectOnly: z.boolean().optional().describe('Only search conversations from the CWD project'),
    likeSession: z.array(z.string()).optional().describe('Boost results similar to these session IDs (format: ["123"] or ["123:1.5"])'),
    unlikeSession: z.array(z.string()).optional().describe('Suppress results similar to these session IDs'),
    likeProject: z.array(z.string()).optional().describe('Boost results matching these project IDs'),
    unlikeProject: z.array(z.string()).optional().describe('Suppress results matching these project IDs'),
    includeAutomated: z.boolean().optional().describe('Include automated, non-interactive sessions (Slack monitoring, curiosity curation, MCP health checks, huddle transcripts). Excluded by default.'),
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
  `Get a session's DIGEST — summary + chunk map. NO raw messages.

BREAKING CHANGE: getSession no longer dumps messages. It returns the middle
rung of disclosure: the session summary plus a manifest of its chunks, each with
a one-line summary and a { start_message_id, end_message_id } range. Read the
region you want with getMessages; don't pull the whole thread.

Each chunk is a SECTION SUMMARY — one paragraph standing in for a span of
~dozens of messages (not a per-message summary). The manifest is itself paged:
it returns up to chunkLimit sections from chunkOffset, with total_chunks so you
can page a long session instead of pulling all summaries at once.

Returns: { summary, title, project, message_count, date, tokens, total_chunks,
           chunks: [{ index, summary, start_message_id, end_message_id, chars }] }`,
  {
    sessionId: z.number().describe('Session ID from search results'),
    chunkOffset: z.number().optional().describe('First section to return (0-based, default 0)'),
    chunkLimit: z.number().optional().describe('Max sections to return (default 20)'),
  },
  async (params) => {
    const digest = await getSessionDigest(params)
    if (!digest) return { content: [{ type: 'text', text: 'Session not found.' }] }
    return { content: [{ type: 'text', text: formatDigest(digest) }] }
  }
)

server.tool(
  'getSessionTranscript',
  `Resolve a session by external ID or title and return its DIGEST.

Despite the name, this aliases getSession (digest, not raw transcript) — it just
resolves the session differently: exact external_id match first, then ILIKE
title search. Use getMessages to read raw messages once you have the session.`,
  {
    searchTerm: z.string().describe('Session external_id or title search term'),
  },
  async (params) => {
    const digest = await getSessionDigest({ searchTerm: params.searchTerm })
    if (!digest)
      return {
        content: [{ type: 'text', text: `No session found matching: ${params.searchTerm}` }],
        isError: true,
      }
    return { content: [{ type: 'text', text: formatDigest(digest) }] }
  }
)

server.tool(
  'getMessages',
  `Read RAW messages, windowed. Two modes:

- Browse a window: { sessionId, offset?, limit? } — default limit 30 (never the
  whole thread). Page with offset.
- Read a chunk's region: { startMessageId, endMessageId } — the id range
  straight off a getSession chunk-manifest entry. sessionId is inferred if omitted.

BUDGETED: total content is capped at a default char budget (~24K chars) so a big
chunk can't dump tens of thousands of tokens in one call. Whole messages are
kept up to the budget; when more remain the result tells you the next offset /
startMessageId to page. Override the cap with maxChars.

OVERSIZED MESSAGES: a single message larger than the whole budget comes back as
a stub (its size + a short preview) with a getMessage({ id }) pointer — its full
content is never dumped inline.`,
  {
    sessionId: z.number().optional().describe('Session ID (required for windowed browse)'),
    offset: z.number().optional().describe('Window start (0-based, default 0)'),
    limit: z.number().optional().describe('Window size (default 30)'),
    startMessageId: z.number().optional().describe('Start of a message-id range (from a chunk manifest)'),
    endMessageId: z.number().optional().describe('End of a message-id range (from a chunk manifest)'),
    maxChars: z.number().optional().describe('Override the default char budget'),
  },
  async (params) => {
    const result = await getMessages(params)
    if (!result) return { content: [{ type: 'text', text: 'No messages found.' }] }
    return { content: [{ type: 'text', text: formatMessages(result) }] }
  }
)

server.tool(
  'getMessage',
  `Read ONE message in full by id, uncapped. The escape hatch for an oversized
message that getMessages returned as a stub — reaching its full content requires
this deliberate call, so a huge payload can never arrive by accident.`,
  {
    id: z.number().describe('Message id (from a getMessages stub)'),
  },
  async (params) => {
    const message = await getMessageById(params.id)
    if (!message) return { content: [{ type: 'text', text: 'Message not found.' }] }
    return { content: [{ type: 'text', text: formatMessage(message) }] }
  }
)

server.tool(
  'getChunk',
  `Get one chunk's full summary by { sessionId, chunkIndex } — the middle step
between a getSession manifest line and reading raw messages, when the one-line
manifest summary isn't enough to decide. Includes the message-id range to hand
to getMessages.`,
  {
    sessionId: z.number().describe('Session ID'),
    chunkIndex: z.number().describe('Chunk index from the getSession manifest'),
  },
  async (params) => {
    const chunk = await getChunk(params)
    if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] }
    return { content: [{ type: 'text', text: formatChunk(chunk, params.sessionId) }] }
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

server.tool(
  'health',
  `Report mindmeld's own indexing health so silent degradation is visible.

Surfaces three areas; "unhealthy" cues are documented inline in the output:

SUMMARY COVERAGE
- total sessions; sessions with a non-NULL summary (excluding deleted + 'Warmup')
- coverage % = summarized / (summarized + real NULL backlog)
- NULL-summary backlog: summary IS NULL, not deleted, not 'Warmup', message_count > 0

SUMMARY QUALITY
- count of bad summaries by signal (too_short, over_compressed, raw_message_leak,
  code_dump, refusal, loopy, truncated, marker_only, no_update, json_dump) plus
  '[unsummarizable]' markers. Signals mirror scripts/audit-summaries.sh.

EMBEDDING FRESHNESS
- age of the most recent convo-sessions and convo-messages embedding
- pending message-embedding count (work the backfill still owes)

Use this to confirm the pipeline is actually keeping up, not just degrading quietly.`,
  {},
  async () => {
    const metrics = await getHealth()
    return { content: [{ type: 'text', text: formatHealth(metrics) }] }
  }
)

server.tool(
  'reportUselessSession',
  `Soft-delete a session that pollutes search results.

Use this when search returns results that are clearly noise — automated runs,
monitoring jobs, repeated boilerplate sessions, or anything that isn't a real
interactive conversation. Soft-deletes the session so it stops appearing in search.

Call this proactively whenever you get useless results back from search.`,
  {
    sessionId: z.number().describe('Session ID to soft-delete'),
    reason: z.string().optional().describe('Why this session is useless (for logging)'),
  },
  async ({ sessionId, reason }) => {
    const result = await query(
      `UPDATE sessions SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [sessionId]
    )
    if (result.rowCount === 0)
      return { content: [{ type: 'text', text: `Session ${sessionId} not found or already deleted.` }] }
    if (reason) console.error(`Session ${sessionId} reported as useless: ${reason}`)
    return { content: [{ type: 'text', text: `Session ${sessionId} soft-deleted.` }] }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', async () => {
  await closePool()
  process.exit(0)
})
