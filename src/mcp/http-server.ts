import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { listProjects, listSessions, getActivity } from './browse.js'
import { toSearchHit, toDigest, toMessages, toMessage } from './rest.js'
import { listQuarantine, replayQuarantine, countPending } from '../sync/quarantine.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { query, closePool } from '../db/postgres.js'
import { runMigrations } from '../db/migrations.js'
import { searchWithDiagnostics, findProjectsByPath, UnknownDataClassError } from './search.js'
import { IngestPayloadSchema, ingestConversation, MissingDataClassError } from './ingest.js'
import { getSessionDigest, getMessages, getMessageById } from './session.js'
import { createMcpServer } from './tools.js'
import { getSyncStatus } from '../sync/orchestrator.js'
import { startSyncRun, getSyncRunState } from './sync-run.js'
import { pendingMessagesCount, pendingSessionsCount } from '../embeddings/pending.js'
import { getThroughput, clampWindow } from './throughput.js'
import { readSystemStatus } from './system-status.js'
import { getSummaryStatus } from './summary-status.js'
import { getEmbeddingSeries, clampSeriesWindow } from './embedding-series.js'
import { readStandDown, standDown, resumeSync } from '../sync/stand-down.js'
import { getCollectionStats } from '../db/chroma.js'
import { config } from '../config.js'
import { ensureEmbeddingModel } from '../embeddings/ollama.js'
import { captureConsole, type LogLevel } from './log-buffer.js'
import { getMachineActivity, getMachineSessions, mostRecentlyIndexed } from './machines.js'
import { readStoredLogs, countStoredLogs, getLogWriters } from './stored-logs.js'
import { startDbLogSink, installFlushOnExit, sinkStats, flushLogs } from '../logging/db-sink.js'
import { ensureSummarizeModel } from '../embeddings/summarize.js'
import { createRequire } from 'node:module'
import { resolveTitle } from './title.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

// The MCP tool surface is shared verbatim with the stdio transport
// (src/mcp/server.ts) - see src/mcp/tools.ts. Declaring the tools here as
// well is what let the two drift, so this transport declares none of its own.
const getServer = createMcpServer

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000

// Installed before anything else logs so /logs sees startup too.
captureConsole(startDbLogSink('mcp'))
installFlushOnExit()

// DNS-rebinding protection. The defaults cover local and in-compose access; a
// deployment reached through a Cloudflare tunnel arrives with the tunnel's
// hostname in the Host header, so that name has to be listed explicitly —
// ALLOWED_HOSTS is a comma-separated addition, never a replacement.
const ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  'mcp',
  ...(process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean),
]

const app = express()
app.use(hostHeaderValidation(ALLOWED_HOSTS))
app.use(express.json({ limit: '10mb' }))

// The browser UI. The dedicated `ui` service (src/ui/server.ts, its own
// container) is the front door for the public hostname; this copy stays so the
// API service remains fully standalone — opening localhost:3847 in a browser
// still works, and the domain keeps serving whether the tunnel ingress points
// at `ui` or (legacy) here.
// The app shell and the service worker are revalidated every load — a stale
// shell would pin the UI to an old API contract; hashed-free static assets are
// small enough that no-cache costs little.
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url))

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, path) => {
      if (path.endsWith('.html') || path.endsWith('sw.js'))
        res.setHeader('Cache-Control', 'no-cache')
    },
  })
)

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

// The REST surface documents itself: serve the spec that ships in the image, so
// what a deployment claims can never drift from what that deployment runs.
const OPENAPI_PATH = fileURLToPath(new URL('../../docs/openapi.yaml', import.meta.url))

app.get('/openapi.yaml', async (req: any, res: any) => {
  try {
    res.type('application/yaml').send(await readFile(OPENAPI_PATH, 'utf8'))
  } catch {
    res.status(404).json({ status: 'error', error: 'OpenAPI spec not bundled in this deployment' })
  }
})

app.get(['/api/status', '/status'], async (req: any, res: any) => {
  try {
    const syncStatus = await getSyncStatus()

    const recentlyProcessed = await query<{
      id: number
      title: string | null
      summary: string | null
      project: string
      last_synced_at: string
      message_count: number
    }>(`
      SELECT s.id, s.title, s.summary, p.name as project,
             s.last_synced_at, s.message_count
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.last_synced_at > NOW() - INTERVAL '10 minutes'
        AND s.deleted_at IS NULL
      ORDER BY s.last_synced_at DESC
      LIMIT 10
    `)

    // Both counts use the embedder's own predicate (src/embeddings/pending.ts),
    // so what this screen calls pending is what a worker will actually pick up.
    // Counting anything looser advertised a 32k backlog against zero real work.
    const pendingMessagesQuery = pendingMessagesCount()
    const pendingMessages = await query<{ count: string }>(
      pendingMessagesQuery.sql,
      pendingMessagesQuery.params,
    )

    const pendingSessionsQuery = pendingSessionsCount(config.chroma.collections.sessions)
    const pendingSessions = await query<{ count: string }>(
      pendingSessionsQuery.sql,
      pendingSessionsQuery.params,
    )

    const quarantined = await countPending()

    const latestSession = await query<{
      started_at: string
      title: string | null
      summary: string | null
      project: string
    }>(`
      SELECT s.started_at, s.title, s.summary, p.name as project
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.deleted_at IS NULL
        AND COALESCE(s.title, '') NOT ILIKE '%briefing%'
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
          title: resolveTitle(r).title,
          titleSource: resolveTitle(r).titleSource,
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
      quarantined,
      chroma: { collections: chromaCollections },
      latestSession: latest
        ? {
            startedAt: latest.started_at,
            title: resolveTitle(latest).title,
            titleSource: resolveTitle(latest).titleSource,
            project: latest.project,
          }
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

const LOG_LEVELS: LogLevel[] = ['log', 'warn', 'error']

// Bounded so a single call can't try to serialise the whole buffer at once;
// walk further back with ?offset= rather than expecting a truncated response.
const MAX_LOG_LIMIT = 500

const parseCount = (raw: unknown, fallback: number) => {
  if (raw === undefined) return fallback
  const n = parseInt(String(raw), 10)
  return Number.isFinite(n) ? n : NaN
}

// Shared by both log routes. Returns an error string, or the parsed page.
const parsePaging = (req: any): { error: string } | { limit: number; offset: number } => {
  const limit = parseCount(req.query.limit, 100)
  const offset = parseCount(req.query.offset, 0)

  if (Number.isNaN(limit) || limit < 1 || limit > MAX_LOG_LIMIT)
    return { error: `limit must be an integer between 1 and ${MAX_LOG_LIMIT}` }
  if (Number.isNaN(offset) || offset < 0)
    return { error: 'offset must be a non-negative integer' }

  return { limit, offset }
}

// Both path prefixes are served: /api/logs matches the other /api routes,
// /logs is the shorter form to type on a phone.
app.get(['/api/logs', '/logs'], async (req: any, res: any) => {
  try {
    const paging = parsePaging(req)
    if ('error' in paging) {
      res.status(400).json({ status: 'error', error: paging.error })
      return
    }

    const level = req.query.level as string | undefined
    if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel)) {
      res.status(400).json({
        status: 'error',
        error: `level must be one of ${LOG_LEVELS.join(', ')}`,
      })
      return
    }

    // So lines this process emitted moments ago are in the response rather than
    // still sitting in the sink's queue.
    await flushLogs()

    const filter = {
      ...paging,
      level,
      machine: req.query.machine as string | undefined,
      service: req.query.service as string | undefined,
      contains: req.query.contains as string | undefined,
    }

    const [machines, entries, total, writers] = await Promise.all([
      getMachineActivity(),
      readStoredLogs(filter),
      countStoredLogs(filter),
      getLogWriters(),
    ])

    res.json({
      status: 'ok',
      name: 'mindmeld',
      version,
      thisMachine: config.machine,
      lastIndexedMachine: mostRecentlyIndexed(machines),
      machines,
      // Every process that has ever shipped logs, so a machine that stopped
      // reporting shows up as a stale lastLoggedAt instead of just vanishing.
      logWriters: writers,
      entries,
      returned: entries.length,
      total,
      ...paging,
      sink: sinkStats(),
    })
  } catch (error) {
    console.error('[API] Logs error:', error)
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get(['/api/logs/:machine', '/logs/:machine'], async (req: any, res: any) => {
  try {
    const paging = parsePaging(req)
    if ('error' in paging) {
      res.status(400).json({ status: 'error', error: paging.error })
      return
    }

    const level = req.query.level as string | undefined
    if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel)) {
      res.status(400).json({
        status: 'error',
        error: `level must be one of ${LOG_LEVELS.join(', ')}`,
      })
      return
    }

    await flushLogs()

    const requested = String(req.params.machine)
    const machines = await getMachineActivity()
    const writers = await getLogWriters()
    const activity = machines.find(m => m.machine === requested)
    const writesLogs = writers.some(w => w.machine === requested)

    // A machine may have indexed projects, or shipped logs, or both — it is
    // only genuinely unknown when neither is true.
    if (!activity && !writesLogs) {
      const known = [...new Set([...machines.map(m => m.machine), ...writers.map(w => w.machine)])]
      res.status(404).json({
        status: 'error',
        error: `nothing recorded for machine '${requested}'`,
        knownMachines: known,
      })
      return
    }

    const filter = {
      ...paging,
      level,
      machine: requested,
      service: req.query.service as string | undefined,
      contains: req.query.contains as string | undefined,
    }

    const [entries, total, sessions] = await Promise.all([
      readStoredLogs(filter),
      countStoredLogs(filter),
      activity
        ? getMachineSessions(requested, paging.limit, paging.offset)
        : Promise.resolve([]),
    ])

    res.json({
      status: 'ok',
      name: 'mindmeld',
      version,
      machine: requested,
      isThisMachine: requested === config.machine,
      activity: activity ?? null,
      logWriters: writers.filter(w => w.machine === requested),
      entries,
      returned: entries.length,
      total,
      sessions,
      ...paging,
    })
  } catch (error) {
    console.error('[API] Machine logs error:', error)
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

// Every read route shares one error shape so the UI can render failures without
// special-casing which endpoint produced them.
const apiRoute =
  (label: string, handler: (req: any, res: any) => Promise<void>) =>
  async (req: any, res: any) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error(`[API] ${label} error:`, error)
      if (!res.headersSent)
        res.status(500).json({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
  }

const intParam = (raw: unknown, fallback: number) => {
  if (raw === undefined || raw === '') return fallback
  const n = parseInt(String(raw), 10)
  return Number.isFinite(n) ? n : fallback
}

const boolParam = (raw: unknown) => raw === 'true' || raw === '1'

// Search over the same index the MCP tool uses — same fusion, same filters —
// returning the structured results rather than the MCP text rendering.
app.get('/api/search', apiRoute('Search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const mode = req.query.mode as 'semantic' | 'text' | 'hybrid' | undefined

  if (!q?.trim()) {
    res.status(400).json({ status: 'error', error: 'q is required' })
    return
  }

  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined

  // ?dataClass=coding&dataClass=personal or ?dataClass=coding,personal both
  // work; absent means the search-layer default (coding only).
  const rawDataClass = req.query.dataClass
  const dataClass =
    rawDataClass === undefined
      ? undefined
      : (Array.isArray(rawDataClass) ? rawDataClass.map(String) : String(rawDataClass).split(','))
          .map(s => s.trim())
          .filter(Boolean)

  let outcome
  try {
    outcome = await searchWithDiagnostics({
      query: q,
      negativeQuery: typeof req.query.not === 'string' ? req.query.not : undefined,
      mode: mode && ['semantic', 'text', 'hybrid'].includes(mode) ? mode : 'hybrid',
      limit: Math.min(intParam(req.query.limit, 20), 100),
      source: typeof req.query.source === 'string' ? req.query.source : undefined,
      since: typeof req.query.since === 'string' ? req.query.since : undefined,
      cwd,
      projectOnly: boolParam(req.query.projectOnly),
      includeAutomated: boolParam(req.query.includeAutomated),
      includeUnsummarized: boolParam(req.query.includeUnsummarized),
      dataClass: dataClass?.length ? dataClass : undefined,
    })
  } catch (error) {
    // A typo'd class is a caller mistake, not a server fault — 400, with the
    // valid vocabulary in the message.
    if (error instanceof UnknownDataClassError) {
      res.status(400).json({ status: 'error', error: error.message })
      return
    }
    throw error
  }

  const projectIds = cwd ? (await findProjectsByPath(cwd)).map(p => p.id) : []

  res.json({
    status: 'ok',
    query: q,
    mode: mode ?? 'hybrid',
    count: outcome.results.length,
    projectIds,
    // Additive and null on a healthy search, so nothing that ignores it breaks.
    // Non-null means the vector arms were skipped and these results came from
    // full text alone — the difference between "no such conversation" and "the
    // GPU gate was shut", which are indistinguishable from the results list.
    degraded: outcome.degraded,
    results: outcome.results.map(toSearchHit),
  })
}))

app.get('/api/projects', apiRoute('Projects', async (_req, res) => {
  const projects = await listProjects()
  res.json({ status: 'ok', count: projects.length, projects })
}))

app.get('/api/sessions', apiRoute('Sessions', async (req, res) => {
  const { items, total } = await listSessions({
    limit: Math.min(intParam(req.query.limit, 30), 200),
    offset: Math.max(intParam(req.query.offset, 0), 0),
    projectId: req.query.projectId ? intParam(req.query.projectId, 0) : undefined,
    source: typeof req.query.source === 'string' ? req.query.source : undefined,
    machine: typeof req.query.machine === 'string' ? req.query.machine : undefined,
    q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
    includeAutomated: boolParam(req.query.includeAutomated),
    includeUnsummarized: boolParam(req.query.includeUnsummarized),
  })
  res.json({ status: 'ok', total, count: items.length, sessions: items })
}))

app.get('/api/sessions/:id', apiRoute('Session digest', async (req, res) => {
  const digest = await getSessionDigest({
    sessionId: intParam(req.params.id, 0),
    chunkOffset: intParam(req.query.chunkOffset, 0),
    chunkLimit: Math.min(intParam(req.query.chunkLimit, 50), 200),
  })
  if (!digest) {
    res.status(404).json({ status: 'error', error: 'Session not found' })
    return
  }
  res.json({ status: 'ok', digest: toDigest(digest) })
}))

app.get('/api/sessions/:id/messages', apiRoute('Session messages', async (req, res) => {
  const result = await getMessages({
    sessionId: intParam(req.params.id, 0),
    offset: req.query.startMessageId ? undefined : Math.max(intParam(req.query.offset, 0), 0),
    limit: Math.min(intParam(req.query.limit, 20), 100),
    startMessageId: req.query.startMessageId ? intParam(req.query.startMessageId, 0) : undefined,
    endMessageId: req.query.endMessageId ? intParam(req.query.endMessageId, 0) : undefined,
    maxChars: Math.min(intParam(req.query.maxChars, 60000), 200000),
  })
  if (!result) {
    res.status(404).json({ status: 'error', error: 'No messages found' })
    return
  }
  res.json({ status: 'ok', ...toMessages(result) })
}))

// The escape hatch for a message that came back TRUNCATED: one message, whole.
app.get('/api/messages/:id', apiRoute('Message', async (req, res) => {
  const message = await getMessageById(intParam(req.params.id, 0))
  if (!message) {
    res.status(404).json({ status: 'error', error: 'Message not found' })
    return
  }
  res.json({ status: 'ok', message: toMessage(message) })
}))

app.get('/api/machines', apiRoute('Machines', async (_req, res) => {
  const [machines, writers] = await Promise.all([getMachineActivity(), getLogWriters()])
  res.json({
    status: 'ok',
    thisMachine: config.machine,
    lastIndexedMachine: mostRecentlyIndexed(machines),
    machines,
    logWriters: writers,
  })
}))

app.get('/api/activity', apiRoute('Activity', async (req, res) => {
  const days = Math.min(Math.max(intParam(req.query.days, 30), 1), 365)
  res.json({ status: 'ok', days, activity: await getActivity(days) })
}))

// Records sync could not process, kept whole for replay. A non-zero count means
// data is waiting, not that data was lost.
app.get('/api/quarantine', apiRoute('Quarantine', async (req, res) => {
  const { items, total } = await listQuarantine({
    limit: Math.min(intParam(req.query.limit, 50), 200),
    offset: Math.max(intParam(req.query.offset, 0), 0),
    includeResolved: boolParam(req.query.includeResolved),
    // Payloads are whole records and can be large, so a listing omits them
    // unless asked. This is paging, not truncation.
    withPayload: boolParam(req.query.withPayload),
  })
  res.json({ status: 'ok', total, count: items.length, pending: await countPending(), records: items })
}))

// Retrying is always safe: a record that fails again keeps its row with the new
// error and a bumped attempt count, and one that succeeds is marked resolved.
app.post('/api/quarantine/retry', apiRoute('Quarantine retry', async (req, res) => {
  const id = req.body?.id ?? req.query.id
  const result = await replayQuarantine({
    id: id === undefined ? undefined : intParam(id, 0),
    limit: Math.min(intParam(req.body?.limit ?? req.query.limit, 100), 500),
  })
  res.json({ status: 'ok', ...result, pending: await countPending() })
}))

// Is the embedding queue being worked off, how fast, and when does it end?
// `minutes` sets the measurement window (default 60, clamped to 1..1440).
app.get('/api/throughput', apiRoute('Throughput', async (req, res) => {
  res.json({ status: 'ok', ...(await getThroughput(clampWindow(req.query.minutes))) })
}))

// Trigger an ingestion pass by hand rather than waiting out the sync interval.
// 202, not 200: a drain takes minutes, so the run is detached and its progress
// is read back from GET /api/sync. A press while one is already running is not
// an error the caller made — 409 carries the running run's state so the UI can
// just show it.
app.post('/api/sync', apiRoute('Sync run', async (_req, res) => {
  const { started, state } = startSyncRun()
  res.status(started ? 202 : 409).json({
    status: 'ok',
    started,
    run: state,
    message: started
      ? 'Ingestion run started — embedding pending messages.'
      : 'An ingestion run is already in flight.',
  })
}))

app.get('/api/sync', apiRoute('Sync run state', async (_req, res) => {
  res.json({ status: 'ok', run: getSyncRunState() })
}))

// Live health of the three dependencies that can each stall the pipeline on
// their own — the Ollama gate, Chroma, and CPU/GPU load. Every field is a probe
// with its own timeout, so this answers even when all three are down.
app.get('/api/system', apiRoute('System status', async (_req, res) => {
  res.json({ status: 'ok', ...(await readSystemStatus()) })
}))

// The slow phase on its own terms: what is being summarized right now, how far
// back the queue reaches, and whether more than one worker is duplicating it.
app.get('/api/summaries', apiRoute('Summary status', async (_req, res) => {
  res.json({ status: 'ok', ...(await getSummaryStatus()) })
}))

// The pipeline over time rather than averaged into one rate — the graph on the
// overview. `minutes` sets the span (default 360, clamped to 10..1440); the
// bucket size is derived from it to keep roughly 60 points.
app.get('/api/embedding-series', apiRoute('Embedding series', async (req, res) => {
  res.json({ status: 'ok', ...(await getEmbeddingSeries(clampSeriesWindow(req.query.minutes))) })
}))

// The stand-down switch: "stop what you are doing and pick it up next cycle."
//
// GET is safe to poll; the UI counts `secondsRemaining` down locally rather
// than re-deriving it from `until` against a client clock that may disagree
// with the server's.
app.get('/api/stand-down', apiRoute('Stand-down state', async (_req, res) => {
  res.json({ status: 'ok', ...(await readStandDown()) })
}))

// POST asks ingestion to stand down for `minutes` (clamped 1..240, default 15).
// Deliberately a short deadline rather than a pause flag — a forgotten press
// costs one cycle, and cannot freeze the index. `reason` is free text shown on
// the dashboard so a stand-down can say who asked and why.
app.post('/api/stand-down', apiRoute('Stand down', async (req, res) => {
  const { minutes, reason } = req.body ?? {}
  res.json({ status: 'ok', ...(await standDown(minutes, reason ?? null)) })
}))

// Clearing the deadline rather than waiting it out: "I finished playing, get
// back to work" should not cost the rest of the window.
app.post('/api/stand-down/resume', apiRoute('Resume sync', async (_req, res) => {
  res.json({ status: 'ok', ...(await resumeSync()) })
}))

app.post('/api/ingest', async (req: any, res: any) => {
  try {
    const payload = IngestPayloadSchema.parse(req.body)
    const result = await ingestConversation(payload)
    res.json({ success: true, ...result })
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation failed', details: error.errors })
      return
    }
    // The caller's mistake, not ours: creating a source demands a dataClass.
    if (error instanceof MissingDataClassError) {
      res.status(400).json({ success: false, error: error.message })
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

  // Pull models to disk if not present (does NOT load into VRAM)
  Promise.all([ensureEmbeddingModel(), ensureSummarizeModel()])
    .then(() => console.log('[MCP HTTP] Models verified'))
    .catch(e => console.warn('[MCP HTTP] Model pull check failed (non-fatal):', e.message))

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
