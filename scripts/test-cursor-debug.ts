import { setDatabasePath, listConversations, listMessages, queryAll } from '@redaphid/cursor-conversations'
import { homedir } from 'os'
import { copyFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

const main = async () => {
  // Copy DB to tmp
  const srcPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
  const tmpDir = join(dirname(new URL(import.meta.url).pathname), '../tmp')
  const destPath = join(tmpDir, 'cursor-test.db')

  await mkdir(tmpDir, { recursive: true })
  await copyFile(srcPath, destPath)

  const walPath = `${srcPath}-wal`
  const shmPath = `${srcPath}-shm`
  if (existsSync(walPath)) await copyFile(walPath, `${destPath}-wal`)
  if (existsSync(shmPath)) await copyFile(shmPath, `${destPath}-shm`)

  setDatabasePath(destPath)

  // Get all conversation IDs from composerData
  const composerIds = await queryAll<{ key: string }>(`
    SELECT key FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
  `)
  const composerIdSet = new Set(composerIds.map(r => r.key.slice('composerData:'.length)))

  // Get all unique conversation IDs from bubbleId entries
  const bubbleConvIds = await queryAll<{ convId: string }>(`
    SELECT DISTINCT substr(key, 10, 36) as convId
    FROM cursorDiskKV
    WHERE key LIKE 'bubbleId:%'
  `)
  const bubbleIdSet = new Set(bubbleConvIds.map(r => r.convId))

  console.log(`composerData entries: ${composerIdSet.size}`)
  console.log(`Unique conversation IDs in bubbleId: ${bubbleIdSet.size}`)

  // Check overlap
  const inBoth = Array.from(bubbleIdSet).filter(id => composerIdSet.has(id))
  console.log(`In both: ${inBoth.length}`)

  // Check what listConversations returns
  const { conversations, total } = await listConversations({ limit: 1000 })
  const listConvIds = new Set(conversations.map(c => c.conversationId))

  console.log(`\nlistConversations returned: ${conversations.length} (total: ${total})`)

  // Check overlap with bubbleId
  const listConvsWithBubbles = Array.from(listConvIds).filter(id => bubbleIdSet.has(id))
  console.log(`listConversations IDs that have bubbleId entries: ${listConvsWithBubbles.length}`)

  // Show some that have bubbleId but aren't in listConversations
  const inBubbleNotInList = Array.from(bubbleIdSet).filter(id => !listConvIds.has(id))
  console.log(`\nIn bubbleId but NOT in listConversations: ${inBubbleNotInList.length}`)
  for (const id of inBubbleNotInList.slice(0, 5)) {
    console.log(`  ${id}`)

    // Check if there's a composerData entry
    const hasComposer = composerIdSet.has(id)
    console.log(`    -> composerData exists: ${hasComposer}`)
  }

  // Test listMessages directly on a bubbleId-only conversation
  console.log('\n--- Testing listMessages on bubbleId-only conversations ---')
  for (const id of inBubbleNotInList.slice(0, 3)) {
    const { messages, count } = await listMessages(id, { limit: 10 })
    console.log(`${id.slice(0, 8)}: ${count} messages, ${messages.filter(m => m.text).length} with text`)
  }
}

main().catch(console.error)
