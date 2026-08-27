import assert from 'node:assert'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { query } from '../db/postgres.js'
import { searchWithDiagnostics, formatSearchResults, findProjectsByPath } from './search.js'
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
import { resolveTitle } from './title.js'
import { applyTags, removeTags, getTags, formatTagWrite, defaultExcludedTags, type TagTarget } from './tags.js'
import { writeNote, formatWrittenNote, NOTE_TAG } from './notes.js'

// addTag/removeTag both take an optional sessionId and an optional messageId
// and require exactly one. Which granularity to use is the tagging agent's
// call -- a whole conversation and a single message are both legitimate things
// to judge -- so the tool refuses to choose for them, and refuses to guess when
// they name both.
const resolveTagTarget = (params: { sessionId?: number; messageId?: number }): TagTarget => {
  const { sessionId, messageId } = params
  if (sessionId != null && messageId != null)
    throw new Error('Pass either sessionId or messageId, not both — a tag targets one thing.')
  if (sessionId != null) return { sessionId }
  if (messageId != null) return { messageId }
  throw new Error('Pass sessionId (tag a whole conversation) or messageId (tag one message).')
}

// The tool surface accepts `tag` (one) or `tags` (several) and treats them as
// one list, so a caller never has to wrap a single tag in an array and a
// caller with five does not need five calls.
const collectTags = (params: { tag?: string; tags?: string[] }): string[] => [
  ...(params.tag ? [params.tag] : []),
  ...(params.tags ?? []),
]


// THE tool surface. Both transports — stdio (server.ts) and Streamable HTTP
// (http-server.ts) — register from here and declare nothing of their own.
//
// This module exists because they used to hand-write these tools twice, and
// the copies drifted: HTTP lost `health` and `getSessionTranscript` outright,
// `search` lost `includeAutomated` (which made automated sessions unreachable
// over HTTP entirely, since they are excluded by default), and every long
// description decayed into a one-liner. Tool descriptions are the LLM's API
// documentation, so that last one is a functional regression too.
//
// src/mcp/tools.test.ts fails if a transport ever registers a tool inline
// again.
const registerTools = (server: McpServer) => {
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
- hybrid: Semantic + full-text, fused by reciprocal rank (default)
- semantic: Vector similarity only
- text: Postgres full-text only — exact phrase/keyword matching

WEIGHTED CENTROID SEARCH:
- likeSession: Boost results similar to specific session(s) style
  Format: ["123"] or ["123:1.5"] for weighted boost
- unlikeSession: Suppress results similar to specific session(s)
- likeProject: Boost results matching specific project(s) topics
- unlikeProject: Suppress results matching these project(s)

Weight scale: 0.3-0.5 (gentle), 1.0 (default), 1.2-1.5 (strong), 2.0+ (aggressive)

TAGS:
- tags: only results carrying any of these (see addTag). Matches a tag on the
  session OR on any of its messages.
- excludeTags: hide results carrying any of these.
- Some tags are hidden by default (currently "useless"). Naming one in "tags"
  overrides that, so hidden results stay reachable on purpose.`,
    {
      query: z.string().optional().describe('Search query - natural language works best for semantic search (optional when using centroid params)'),
      negativeQuery: z.string().optional().describe('Negative query - pushes results away from this concept'),
      excludeTerms: z.string().optional().describe('Hard filter - exclude results containing these terms'),
      cwd: z.string().optional().describe('Current working directory - conversations from matching projects get boosted'),
      mode: z.enum(['semantic', 'text', 'hybrid']).optional().describe('Search mode: hybrid (default), semantic, or text'),
      limit: z.number().optional().describe('Max results to return (default 8)'),
      source: z.string().optional().describe('Filter to specific source'),
      since: sinceSchema.optional(),
      projectOnly: z.boolean().optional().describe('Only search conversations from the CWD project'),
      likeSession: z.array(z.string()).optional().describe('Boost results similar to these session IDs (format: ["123"] or ["123:1.5"])'),
      unlikeSession: z.array(z.string()).optional().describe('Suppress results similar to these session IDs'),
      likeProject: z.array(z.string()).optional().describe('Boost results matching these project IDs'),
      unlikeProject: z.array(z.string()).optional().describe('Suppress results matching these project IDs'),
      includeAutomated: z.boolean().optional().describe('Include automated, non-interactive sessions (Slack monitoring, curiosity curation, MCP health checks, huddle transcripts). Excluded by default.'),
      includeUnsummarized: z.boolean().optional().describe('Include sessions that have not been summarized yet. Excluded by default: an unsummarized session has no title and no session-level vector, so it can only arrive as an untriageable result. Pass true to reach the indexing backlog deliberately.'),
      dataClass: z.array(z.string()).optional().describe('Data classes to search (default ["coding"]). Sources are classified as coding, personal, meetings, etc. Pass ["*"] to search everything, or e.g. ["coding","personal"] to widen. An explicit source param bypasses this default.'),
      tags: z.array(z.string()).optional().describe('Only return results carrying ANY of these tags (OR, not AND). Matches a tag on the session OR on any of its messages, so you do not have to know which granularity the tagging agent chose. Tags are free-form and case-insensitive; an unused tag is not an error, it simply matches nothing. Naming a tag here also overrides its default exclusion — tags:["useless"] is how you deliberately reach hidden sessions.'),
      excludeTags: z.array(z.string()).optional().describe('Hide results carrying ANY of these tags, in addition to the default-excluded set. A tag on the session hides the whole session; a tag on a single message only hides that message\'s own hit.'),
    },
    async (params) => {
      const matchingProjects = params.cwd ? await findProjectsByPath(params.cwd) : []
      const projectIds = matchingProjects.map((p) => p.id)
      const { results, degraded } = await searchWithDiagnostics(params)
      return {
        content: [
          { type: 'text', text: formatSearchResults(results, projectIds, degraded) },
        ],
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

OVERSIZED MESSAGES: a single message larger than the whole budget comes back
TRUNCATED — a labeled preview ("showing first N of M chars") plus a
getMessage({ id }) pointer for the full content. This is the one place output is
truncated, and it's always explicit and recoverable.`,
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
message that getMessages returned TRUNCATED — reaching its full content requires
this deliberate call, so a huge payload can never arrive by accident.`,
    {
      id: z.number().describe('Message id (from a truncated getMessages preview)'),
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

  server.tool(
    'stats',
    'Get statistics about your conversation history',
    {},
    async () => {
      const stats = await query<{
        source_name: string
        data_class: string
        project_count: number
        session_count: number
        message_count: number
      }>(
        `SELECT src.name as source_name,
                src.data_class,
                COUNT(DISTINCT p.id) as project_count,
                COUNT(DISTINCT s.id) as session_count,
                COUNT(m.id) as message_count
         FROM sources src
         LEFT JOIN projects p ON p.source_id = src.id
         LEFT JOIN sessions s ON s.project_id = p.id
         LEFT JOIN messages m ON m.session_id = s.id
         GROUP BY src.name, src.data_class`
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
        output += `**${row.source_name}** (${row.data_class}): ${row.project_count} projects, ${row.session_count} sessions, ${row.message_count} messages\n`

      const byClass = new Map<string, number>()
      for (const row of stats.rows)
        byClass.set(row.data_class, (byClass.get(row.data_class) ?? 0) + Number(row.session_count))

      output += `\n## By Data Class\n\n`
      for (const [dataClass, count] of byClass)
        output += `**${dataClass}:** ${count} sessions\n`

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

  server.tool(
    'addTag',
    `Tag a session or a single message. Tags are how you record a judgement about
something in the index so that later searches can act on it.

THE VOCABULARY IS OPEN. Invent whatever tag is useful — there is no list of
allowed tags, no registration step, and tagging with a word nobody has used
before is not an error. Tags are trimmed and lowercased, so "Useless" and
"useless" are the same tag.

TARGET (pass exactly one):
- sessionId — judges the whole conversation
- messageId — judges one message, leaving the rest of the session alone
Either is fine; pick whichever matches what you actually mean.

FINDING THEM AGAIN: search({ tags: ["your-tag"] }) matches a tag on the session
OR on any of its messages, so a message-level tag is still findable without the
searcher knowing which granularity you chose.

HIDDEN TAGS: some tags hide their session from search by default — currently
${defaultExcludedTags().join(', ') || '(none)'}. Tag a session "useless" when
search returns it as noise (automated runs, monitoring jobs, boilerplate) and it
stops polluting results. This is reversible: removeTag puts it back, and
search({ tags: ["useless"] }) still reaches it deliberately.

Idempotent — re-tagging something changes nothing and is not an error.`,
    {
      sessionId: z.number().optional().describe('Session to tag (mutually exclusive with messageId)'),
      messageId: z.number().optional().describe('Message to tag (mutually exclusive with sessionId)'),
      tag: z.string().optional().describe('A tag to apply. Free-form — any word or phrase.'),
      tags: z.array(z.string()).optional().describe('Several tags to apply at once. Combined with `tag` if both are given.'),
      note: z.string().optional().describe('Optional free-text reason, stored with the tag as provenance.'),
    },
    async (params) => {
      const target = resolveTagTarget(params)
      const requested = collectTags(params)
      if (requested.length === 0)
        return { content: [{ type: 'text', text: 'No tag given. Pass tag: "something" or tags: ["a","b"].' }], isError: true }
      const applied = await applyTags(target, requested, { createdBy: 'mcp', note: params.note })
      const current = await getTags(target)
      return { content: [{ type: 'text', text: formatTagWrite('Tagged', target, applied, current) }] }
    }
  )

  server.tool(
    'removeTag',
    `Remove tags from a session or a message — the inverse of addTag, and the
reason tagging is safe to do freely: nothing about it is permanent.

Removing "useless" from a session returns it to normal search results.

Pass exactly one of sessionId / messageId. Removing a tag that was not there is
reported, not an error.`,
    {
      sessionId: z.number().optional().describe('Session to untag (mutually exclusive with messageId)'),
      messageId: z.number().optional().describe('Message to untag (mutually exclusive with sessionId)'),
      tag: z.string().optional().describe('A tag to remove.'),
      tags: z.array(z.string()).optional().describe('Several tags to remove at once. Combined with `tag` if both are given.'),
    },
    async (params) => {
      const target = resolveTagTarget(params)
      const requested = collectTags(params)
      if (requested.length === 0)
        return { content: [{ type: 'text', text: 'No tag given. Pass tag: "something" or tags: ["a","b"].' }], isError: true }
      const removed = await removeTags(target, requested)
      const current = await getTags(target)
      return { content: [{ type: 'text', text: formatTagWrite('Untagged', target, removed, current) }] }
    }
  )

  server.tool(
    'writeNote',
    `Write something into mindmeld deliberately, so it is searchable later.

Everything else in mindmeld arrived by syncing a transcript off disk. This is
the one tool that puts something in on purpose — reach for it to capture a
decision, a fact, or a reminder now, rather than hoping a conversation about it
gets synced and indexed later. It is also the only write path available to a
client with no transcript of its own (Claude web/mobile via claude.ai), where
nothing typed would otherwise ever reach the index.

FREESTANDING: a note stands on its own. It does not attach to a session or a
message, and there is no parameter to make it do so.

TAGS: every note is automatically tagged "${NOTE_TAG}" — you do not pass it and
you cannot turn it off. That tag is what distinguishes something written on
purpose from synced material, so search({ tags: ["${NOTE_TAG}"] }) returns
notes and nothing else. Any additional tags are yours to choose; the vocabulary
is open, so invent whatever is useful and expect no error for a new word.

Stored as its own one-message session under a source classified dataClass
"notes", the convention other non-coding sources already use (Vikunja,
agent-ops). The session summary is set to the note text immediately, so it is
searchable by full text and by session-tier match right away, with no wait on
the async summarizer.

IMPORTANT: search() defaults to dataClass ["coding"]. A note will NOT show up
in a plain search — pass dataClass: ["notes"] (or ["*"]) to reach it. Use
search/getSession/getMessages to find and read notes back later.`,
    {
      text: z.string().min(1).describe('The note content to write'),
      title: z.string().optional().describe('Optional short title. Derived from the note text when omitted.'),
      tags: z
        .array(z.string())
        .optional()
        .describe(`Optional extra tags, on top of the automatic "${NOTE_TAG}" tag. Free-form — any word or phrase.`),
    },
    async ({ text, title, tags }) => {
      const note = await writeNote({ text, title, tags })
      return { content: [{ type: 'text', text: formatWrittenNote(note) }] }
    }
  )

  // DEPRECATED ALIAS - kept deliberately, and only briefly.
  //
  // When this branch was written, `saveNote` had never shipped, so renaming it
  // to `writeNote` cost nothing and this file deliberately offered no alias.
  // That stopped being true with v1.22.0, which released #131 and put
  // `saveNote` on the live tool surface. Removing a name the running server
  // already advertises would break callers mid-flight, so the old name stays
  // through one deprecation window.
  //
  // This is the SAME implementation, not a second write path: it delegates to
  // writeNote and so gets the automatic "note" tag on exactly the same terms.
  //
  // REMOVAL CONDITION - this is a migration shim, not a permanent dual
  // surface. Delete this whole `server.tool('saveNote', ...)` block, and the
  // 'saveNote' entry in EXPECTED_TOOLS plus the three saveNote tests in
  // tools.test.ts, in the first release cut after one full release cycle
  // passes with no observed `saveNote` call.
  //
  // The alias lives ONLY here, on the tool surface. notes.ts deliberately
  // exports no `saveNote` binding - this handler calls writeNote() directly -
  // so removal is confined to this file and its test.
  server.tool(
    'saveNote',
    `DEPRECATED - use writeNote instead. This name is kept only so callers
written against the v1.22.0 tool surface keep working, and it will be removed.

Behaviour is identical to writeNote, including the automatic "${NOTE_TAG}" tag.
See writeNote for the full description.`,
    {
      text: z.string().min(1).describe('The note content to write'),
      title: z.string().optional().describe('Optional short title. Derived from the note text when omitted.'),
      tags: z
        .array(z.string())
        .optional()
        .describe(`Optional extra tags, on top of the automatic "${NOTE_TAG}" tag. Free-form - any word or phrase.`),
    },
    async ({ text, title, tags }) => {
      const note = await writeNote({ text, title, tags })
      return { content: [{ type: 'text', text: formatWrittenNote(note) }] }
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
        title: string | null
        summary: string | null
        project_name: string
        started_at: Date
        message_count: number
      }>(
        `SELECT s.id, s.title, s.summary, p.name as project_name, s.started_at, s.message_count
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
        contextText += `- **${resolveTitle(session).title ?? `Session ${session.id} (no title — not summarized yet)`}** (${session.started_at.toISOString().split('T')[0]}) - ${session.message_count} messages [ID: ${session.id}]\n`
      }

      contextText += `\n---\n\nUse the \`search\` tool with your current task description to find more specific relevant conversations.`

      return {
        messages: [{ role: 'user', content: { type: 'text', text: contextText } }],
      }
    }
  )

  return server
}

export const createMcpServer = () =>
  registerTools(
    new McpServer({
      name: 'mindmeld',
      version: '0.2.0',
    })
  )
