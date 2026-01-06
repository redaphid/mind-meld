import { query } from '../../src/db/postgres.js'

const checkUnembeddable = async () => {
  // Count unembeddable messages
  const unembeddableCount = await query<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM embeddings
     WHERE chroma_collection = 'UNEMBEDDABLE'`
  )

  // Get details of unembeddable messages
  const unembeddableDetails = await query<{
    message_id: number
    content_preview: string
    session_title: string
    created_at: Date
  }>(
    `SELECT
      e.message_id,
      LEFT(m.content_text, 100) as content_preview,
      s.title as session_title,
      m.timestamp as created_at
     FROM embeddings e
     JOIN messages m ON e.message_id = m.id
     JOIN sessions s ON m.session_id = s.id
     WHERE e.chroma_collection = 'UNEMBEDDABLE'
     ORDER BY m.timestamp DESC
     LIMIT 20`
  )

  // Count total messages
  const totalMessages = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM messages WHERE content_text IS NOT NULL`
  )

  // Count successfully embedded messages
  const embeddedCount = await query<{ count: number }>(
    `SELECT COUNT(DISTINCT message_id) as count
     FROM embeddings
     WHERE chroma_collection = 'convo-messages'`
  )

  // Count messages pending embedding
  const pendingCount = await query<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM messages m
     LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
     LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE'
     WHERE m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10
       AND e.id IS NULL
       AND skip.id IS NULL`
  )

  console.log('\n=== Embedding Status ===\n')
  console.log(`Total messages:       ${totalMessages.rows[0].count.toLocaleString()}`)
  console.log(`Successfully embedded: ${embeddedCount.rows[0].count.toLocaleString()}`)
  console.log(`Pending embedding:     ${pendingCount.rows[0].count.toLocaleString()}`)
  console.log(`Unembeddable (NaN):    ${unembeddableCount.rows[0].count.toLocaleString()}`)

  if (unembeddableDetails.rows.length > 0) {
    console.log('\n=== Unembeddable Messages (most recent 20) ===\n')
    unembeddableDetails.rows.forEach((row, idx) => {
      console.log(`${idx + 1}. Message #${row.message_id}`)
      console.log(`   Session: ${row.session_title}`)
      console.log(`   Preview: ${row.content_preview}...`)
      console.log(`   Date: ${row.created_at}`)
      console.log('')
    })
  }

  process.exit(0)
}

checkUnembeddable().catch(console.error)
