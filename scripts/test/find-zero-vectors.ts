import { ChromaClient } from 'chromadb'
import { query, closePool } from '../../src/db/postgres.js'
import { config } from '../../src/config.js'

const findZeroVectors = async () => {
  console.log('Connecting to Chroma...')
  const chroma = new ChromaClient({ path: config.chroma.url })

  console.log('Getting collection...')
  const collection = await chroma.getCollection({ name: 'convo-messages' })

  console.log('Getting all embeddings from postgres...')
  const result = await query<{ chroma_id: string; message_id: number }>(`
    SELECT chroma_id, message_id
    FROM embeddings
    WHERE chroma_collection = 'convo-messages'
    ORDER BY id
  `)

  console.log(`Checking ${result.rows.length} embeddings for zero vectors...\n`)

  const zeroVectorIds: string[] = []
  const messageIds: number[] = []

  for (const row of result.rows) {
    try {
      const chromaResult = await collection.get({
        ids: [row.chroma_id],
        include: ['embeddings']
      })

      if (chromaResult.embeddings && chromaResult.embeddings[0]) {
        const embedding = chromaResult.embeddings[0] as number[]
        const isZero = embedding.every(val => val === 0)

        if (isZero) {
          console.log(`Found zero vector: chroma_id=${row.chroma_id}, message_id=${row.message_id}`)
          zeroVectorIds.push(row.chroma_id)
          messageIds.push(row.message_id)
        }
      }
    } catch (error: any) {
      console.error(`Error checking ${row.chroma_id}:`, error.message)
    }
  }

  console.log(`\n📊 Summary:`)
  console.log(`   Total embeddings checked: ${result.rows.length}`)
  console.log(`   Zero vectors found: ${zeroVectorIds.length}`)

  if (zeroVectorIds.length > 0) {
    console.log(`\n🗑️  Deleting ${zeroVectorIds.length} zero vectors...`)

    // Delete from Chroma
    await collection.delete({ ids: zeroVectorIds })
    console.log(`   ✅ Deleted from Chroma`)

    // Delete from postgres
    for (const msgId of messageIds) {
      await query(
        `DELETE FROM embeddings WHERE message_id = $1 AND chroma_collection = 'convo-messages'`,
        [msgId]
      )
    }
    console.log(`   ✅ Deleted from postgres`)
    console.log(`\n✨ Cleanup complete. These messages will be re-embedded on next sync.`)
  } else {
    console.log(`\n✅ No zero vectors found!`)
  }
}

findZeroVectors()
  .then(() => closePool())
  .catch(error => {
    console.error('Fatal error:', error)
    closePool()
    process.exit(1)
  })
