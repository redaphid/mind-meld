import { setDatabasePath, listConversations, listMessages } from '@hypnodroid/cursor-conversations'
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

  console.log('DB copied to:', destPath)

  // Set path and test
  setDatabasePath(destPath)

  console.log('\nTesting listConversations...')
  const { conversations, total } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 10
  })

  console.log(`Total: ${total}, returned: ${conversations.length}`)

  for (const c of conversations.slice(0, 3)) {
    console.log(`\n${c.conversationId.slice(0, 8)}:`)
    console.log(`  preview: ${c.preview?.slice(0, 50)}`)
    console.log(`  messageCount: ${c.messageCount}`)
    console.log(`  updatedAt: ${c.updatedAt}`)

    // Get messages for this conversation
    const { messages } = await listMessages(c.conversationId, { limit: 100 })
    console.log(`  listMessages returned: ${messages.length}`)

    const withText = messages.filter(m => m.text?.trim())
    console.log(`  messages with text: ${withText.length}`)
  }
}

main().catch(console.error)
