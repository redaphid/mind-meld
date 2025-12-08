import { setDatabasePath, queryAll } from '@redaphid/cursor-conversations'
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

  // Check composerData value for a missing conversation
  const missingId = '006d236c-6efd-4357-ae11-3b3ec7cede0a'

  const composerData = await queryAll<{ key: string; value: string }>(`
    SELECT key, value FROM cursorDiskKV WHERE key = ?
  `, [`composerData:${missingId}`])

  console.log('composerData for missing conversation:')
  console.log('  key:', composerData[0]?.key)
  console.log('  value is null:', composerData[0]?.value === null)
  console.log('  value is "null":', composerData[0]?.value === 'null')
  console.log('  value length:', composerData[0]?.value?.length)

  if (composerData[0]?.value && composerData[0].value !== 'null') {
    try {
      const parsed = JSON.parse(composerData[0].value)
      console.log('  Parsed successfully!')
      console.log('  createdAt:', parsed.createdAt)
      console.log('  lastUpdatedAt:', parsed.lastUpdatedAt)
    } catch (e) {
      console.log('  Parse error:', e)
    }
  }

  // Count null vs non-null composerData entries
  const nullCount = await queryAll<{ count: number }>(`
    SELECT COUNT(*) as count FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
    AND (value IS NULL OR value = 'null')
  `)

  const nonNullCount = await queryAll<{ count: number }>(`
    SELECT COUNT(*) as count FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
    AND value IS NOT NULL
    AND value != 'null'
  `)

  console.log('\nNull composerData entries:', nullCount[0]?.count)
  console.log('Non-null composerData entries:', nonNullCount[0]?.count)

  // Check if missing conversation IDs have null values
  const bubbleConvIds = await queryAll<{ convId: string }>(`
    SELECT DISTINCT substr(key, 10, 36) as convId
    FROM cursorDiskKV
    WHERE key LIKE 'bubbleId:%'
  `)

  let nullValueCount = 0
  let validValueCount = 0
  let parseErrorCount = 0

  for (const { convId } of bubbleConvIds) {
    const composer = await queryAll<{ value: string }>(`
      SELECT value FROM cursorDiskKV WHERE key = ?
    `, [`composerData:${convId}`])

    const value = composer[0]?.value
    if (!value || value === 'null') {
      nullValueCount++
    } else {
      try {
        JSON.parse(value)
        validValueCount++
      } catch {
        parseErrorCount++
        console.log(`Parse error for ${convId}`)
      }
    }
  }

  console.log('\n--- BubbleId conversations composerData status ---')
  console.log('Null/empty value:', nullValueCount)
  console.log('Valid JSON:', validValueCount)
  console.log('Parse errors:', parseErrorCount)
}

main().catch(console.error)
