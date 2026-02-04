import { appendFileSync, mkdirSync } from 'fs'
import { query, closePool } from '../src/db/postgres.js'
import { getCollection, deleteByIds } from '../src/db/chroma.js'
import { config } from '../src/config.js'

const EXECUTE = process.argv.includes('--execute')
const BATCH_SIZE = 1000
const DELETE_BATCH = 500

interface ChromaEntry {
  id: string
  document: string | null
  metadata: Record<string, unknown> | null
}

const log = (msg: string) => console.log(msg)
const warn = (msg: string) => console.error(msg)

// ── Helpers ──

const extractMessageId = (chromaId: string): number | null => {
  const match = chromaId.match(/^msg-(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}

const extractSessionId = (chromaId: string): number | null => {
  const match = chromaId.match(/^session-(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}

const batchArray = <T>(arr: T[], size: number): T[][] => {
  const batches: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size))
  }
  return batches
}

const getAllChromaEntries = async (collectionName: string, include: ('documents' | 'metadatas')[] = []): Promise<ChromaEntry[]> => {
  const collection = await getCollection(collectionName)
  const total = await collection.count()
  const entries: ChromaEntry[] = []

  log(`  Loading ${total} entries from ${collectionName}...`)
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const result = await collection.get({
      limit: BATCH_SIZE,
      offset,
      include,
    })
    for (let i = 0; i < result.ids.length; i++) {
      entries.push({
        id: result.ids[i],
        document: result.documents?.[i] ?? null,
        metadata: result.metadatas?.[i] as Record<string, unknown> | null,
      })
    }
    if (offset > 0 && offset % 10000 === 0) log(`    ${offset}/${total}...`)
  }

  return entries
}

const chromaDelete = async (collectionName: string, ids: string[], label: string) => {
  if (!EXECUTE) {
    log(`  [dry-run] Would delete ${ids.length} ${label} from ${collectionName}`)
    return
  }
  for (const batch of batchArray(ids, DELETE_BATCH)) {
    await deleteByIds(collectionName, batch)
  }
  log(`  Deleted ${ids.length} ${label} from ${collectionName}`)
}

// ── Phase 1: Backup orphan data ──

const phase1Backup = async () => {
  log('\n═══ Phase 1: Backup orphan data ═══')

  log('  Fetching message vectors from Chroma...')
  const msgEntries = await getAllChromaEntries(config.chroma.collections.messages, ['documents', 'metadatas'])
  log('  Fetching session vectors from Chroma...')
  const sesEntries = await getAllChromaEntries(config.chroma.collections.sessions, ['documents', 'metadatas'])

  const allMsgChromaIds = new Set(msgEntries.map(e => e.id))

  // Find message orphans (Chroma ID not in PG messages)
  const msgIds = msgEntries.map(e => extractMessageId(e.id)).filter((id): id is number => id !== null)
  const existingMsgIds = new Set<number>()

  for (const batch of batchArray(msgIds, BATCH_SIZE)) {
    const result = await query<{ id: number }>(
      `SELECT id FROM messages WHERE id = ANY($1::bigint[])`,
      [batch]
    )
    for (const row of result.rows) existingMsgIds.add(row.id)
  }

  const msgOrphans = msgEntries.filter(e => {
    const id = extractMessageId(e.id)
    return id !== null && !existingMsgIds.has(id)
  })

  // Find session orphans (not in PG or soft-deleted)
  const sesIds = sesEntries.map(e => extractSessionId(e.id)).filter((id): id is number => id !== null)
  const activeSessionIds = new Set<number>()

  for (const batch of batchArray(sesIds, BATCH_SIZE)) {
    const result = await query<{ id: number }>(
      `SELECT id FROM sessions WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
      [batch]
    )
    for (const row of result.rows) activeSessionIds.add(row.id)
  }

  const sesOrphans = sesEntries.filter(e => {
    const id = extractSessionId(e.id)
    return id !== null && !activeSessionIds.has(id)
  })

  const allOrphans = [...msgOrphans, ...sesOrphans]
  log(`  Found ${msgOrphans.length} message orphans, ${sesOrphans.length} session orphans`)

  if (allOrphans.length === 0) {
    log('  Nothing to backup')
    return { msgOrphans, sesOrphans, allMsgChromaIds }
  }

  mkdirSync('tmp', { recursive: true })
  const backupPath = `tmp/chroma-orphans-backup-${Date.now()}.jsonl`

  if (EXECUTE) {
    for (const entry of allOrphans) {
      appendFileSync(backupPath, JSON.stringify(entry) + '\n')
    }
    log(`  Backed up ${allOrphans.length} entries to ${backupPath}`)
  } else {
    log(`  [dry-run] Would backup ${allOrphans.length} entries to ${backupPath}`)
  }

  return { msgOrphans, sesOrphans, allMsgChromaIds }
}

// ── Phase 2: Delete orphan message vectors ──

const phase2DeleteOrphans = async (msgOrphans: ChromaEntry[]) => {
  log('\n═══ Phase 2: Delete orphan message vectors ═══')

  const ids = msgOrphans.map(e => e.id)
  log(`  ${ids.length} orphan message vectors to remove`)

  if (ids.length > 0) {
    await chromaDelete(config.chroma.collections.messages, ids, 'orphan message vectors')
  }
}

// ── Phase 3: Clean session vectors ──

const phase3Sessions = async (sesOrphans: ChromaEntry[]) => {
  log('\n═══ Phase 3: Clean session vectors ═══')

  const toDelete = sesOrphans.map(e => e.id)
  log(`  ${toDelete.length} session vectors to remove (nonexistent or soft-deleted)`)

  if (toDelete.length > 0) {
    await chromaDelete(config.chroma.collections.sessions, toDelete, 'stale session vectors')
  }

  // Clean stale PG embedding records for soft-deleted sessions
  const staleSessionEmbeddings = await query<{ id: number }>(
    `SELECT e.id FROM embeddings e
     JOIN messages m ON e.message_id = m.id
     JOIN sessions s ON m.session_id = s.id
     WHERE e.chroma_collection = $1
       AND s.deleted_at IS NOT NULL`,
    [config.chroma.collections.sessions]
  )

  log(`  ${staleSessionEmbeddings.rowCount} PG embedding records for soft-deleted sessions`)

  if (staleSessionEmbeddings.rowCount && staleSessionEmbeddings.rowCount > 0) {
    const ids = staleSessionEmbeddings.rows.map(r => r.id)
    if (EXECUTE) {
      for (const batch of batchArray(ids, BATCH_SIZE)) {
        await query(`DELETE FROM embeddings WHERE id = ANY($1::bigint[])`, [batch])
      }
      log(`  Deleted ${ids.length} stale PG session embedding records`)
    } else {
      log(`  [dry-run] Would delete ${ids.length} stale PG session embedding records`)
    }
  }
}

// ── Phase 4: Clean stale PG embedding records ──

const phase4StaleEmbeddings = async (allMsgChromaIds: Set<string>) => {
  log('\n═══ Phase 4: Clean stale PG embedding records ═══')

  const pgEmbeddings = await query<{ id: number; chroma_id: string }>(
    `SELECT id, chroma_id FROM embeddings WHERE chroma_collection = $1`,
    [config.chroma.collections.messages]
  )

  if (pgEmbeddings.rows.length === 0) {
    log('  No PG embedding records to check')
    return
  }

  log(`  Checking ${pgEmbeddings.rows.length} PG embedding records against Chroma...`)

  const stale = pgEmbeddings.rows.filter(r => !allMsgChromaIds.has(r.chroma_id))
  log(`  Found ${stale.length} PG records pointing to nonexistent Chroma entries`)

  if (stale.length > 0) {
    const ids = stale.map(r => r.id)
    if (EXECUTE) {
      for (const batch of batchArray(ids, BATCH_SIZE)) {
        await query(`DELETE FROM embeddings WHERE id = ANY($1::bigint[])`, [batch])
      }
      log(`  Deleted ${ids.length} stale PG embedding records`)
    } else {
      log(`  [dry-run] Would delete ${ids.length} stale PG embedding records`)
    }
  }
}

// ── Main ──

const main = async () => {
  log(`\n╔══════════════════════════════════════╗`)
  log(`║     Chroma Dedup & Orphan Cleanup    ║`)
  log(`║     Mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}${EXECUTE ? '                  ' : '                  '}║`)
  log(`╚══════════════════════════════════════╝`)

  try {
    const { msgOrphans, sesOrphans, allMsgChromaIds } = await phase1Backup()
    await phase2DeleteOrphans(msgOrphans)
    await phase3Sessions(sesOrphans)
    await phase4StaleEmbeddings(allMsgChromaIds)

    log('\n═══ Complete ═══')
    if (!EXECUTE) {
      log('This was a dry run. Use --execute to apply changes.')
    }
  } catch (error) {
    warn(`Fatal error: ${error}`)
    process.exit(1)
  } finally {
    await closePool()
  }
}

main()
