import { setDatabasePath, queryAll } from '@redaphid/cursor-conversations'
import { getConversationSummary, getMessageData } from '@redaphid/cursor-conversations/tools'
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

  // Get raw rows
  const rows = await queryAll<{ key: string; value: string }>(`
    SELECT key, value
    FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
    AND value IS NOT NULL
    AND value != 'null'
    ORDER BY COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.createdAt')) DESC
    LIMIT 1000
  `)

  console.log(`Total valid rows: ${rows.length}`)

  let succeeded = 0
  let failed = 0
  const failures: string[] = []

  for (const row of rows) {
    const conversationId = row.key.slice('composerData:'.length)
    try {
      const parsed = JSON.parse(row.value)
      const summary = await getConversationSummary(
        { ...parsed, conversationId },
        (convId, msgId) => getMessageData(convId, msgId)
      )
      succeeded++
    } catch (e) {
      failed++
      if (failures.length < 5) {
        failures.push(`${conversationId}: ${e}`)
      }
    }
  }

  console.log(`Succeeded: ${succeeded}`)
  console.log(`Failed: ${failed}`)

  if (failures.length) {
    console.log('\nFirst 5 failures:')
    for (const f of failures) {
      console.log(`  ${f}`)
    }
  }
}

main().catch(console.error)
