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

  setDatabasePath(destPath)

  // Get more conversations
  console.log('Testing with limit 100...')
  const { conversations, total } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 100
  })

  console.log(`Total: ${total}, returned: ${conversations.length}`)

  // Count how many have messages
  let withMessages = 0
  let withoutMessages = 0

  for (const c of conversations) {
    const { messages } = await listMessages(c.conversationId, { limit: 10 })
    if (messages.length > 0) {
      withMessages++
      if (withMessages <= 5) {
        console.log(`\nConv with messages: ${c.conversationId.slice(0, 8)}`)
        console.log(`  preview: ${c.preview?.slice(0, 50)}`)
        console.log(`  messageCount (from summary): ${c.messageCount}`)
        console.log(`  listMessages returned: ${messages.length}`)
      }
    } else {
      withoutMessages++
    }
  }

  console.log(`\n--- Summary ---`)
  console.log(`With messages: ${withMessages}`)
  console.log(`Without messages: ${withoutMessages}`)
}

main().catch(console.error)
