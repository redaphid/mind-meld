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

  // Run the exact same query as listConversations
  console.log('Running same query as listConversations with limit 1000...')
  const rows = await queryAll<{ key: string; value: string }>(`
    SELECT key, value
    FROM cursorDiskKV
    WHERE key LIKE ?
    ORDER BY COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.createdAt')) DESC
    LIMIT ? OFFSET ?
  `, ['composerData:%', 1000, 0])

  console.log(`Rows returned: ${rows.length}`)

  // Count how many get filtered
  let nullFiltered = 0
  let parseErrors = 0
  let valid = 0

  for (const row of rows) {
    if (!row.value || row.value === 'null') {
      nullFiltered++
      continue
    }
    try {
      JSON.parse(row.value)
      valid++
    } catch {
      parseErrors++
    }
  }

  console.log(`Null/empty filtered: ${nullFiltered}`)
  console.log(`Parse errors: ${parseErrors}`)
  console.log(`Valid after filter: ${valid}`)

  // Check if target conversation is in rows
  const targetId = '006d236c-6efd-4357-ae11-3b3ec7cede0a'
  const targetRow = rows.find(r => r.key === `composerData:${targetId}`)
  console.log(`\nTarget ${targetId} in query results: ${!!targetRow}`)

  // Get position of target in sorted results
  const sortedIds = rows.filter(r => r.value && r.value !== 'null').map(r => {
    const parsed = JSON.parse(r.value)
    return {
      id: r.key.slice('composerData:'.length),
      sortVal: parsed.lastUpdatedAt || parsed.updatedAt || parsed.createdAt
    }
  })

  const targetIndex = sortedIds.findIndex(r => r.id === targetId)
  console.log(`Target index in sorted results: ${targetIndex}`)
  if (targetIndex >= 0) {
    console.log(`Target sortVal: ${sortedIds[targetIndex].sortVal}`)
  }

  // Show some context around where target should be
  console.log('\nFirst 5 sortVals:')
  for (const r of sortedIds.slice(0, 5)) {
    console.log(`  ${r.id.slice(0, 8)}: ${r.sortVal}`)
  }

  console.log('\nAround target position:')
  if (targetIndex >= 0) {
    for (const r of sortedIds.slice(Math.max(0, targetIndex - 2), targetIndex + 3)) {
      const marker = r.id === targetId ? '>>>' : '   '
      console.log(`${marker} ${r.id.slice(0, 8)}: ${r.sortVal}`)
    }
  }
}

main().catch(console.error)
