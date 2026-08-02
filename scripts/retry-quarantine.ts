// Replay records sync could not process:
//
//   pnpm run quarantine            # what is waiting
//   pnpm run quarantine -- --retry # put it back
//
// Safe to run repeatedly: a record that fails again keeps its row, its error,
// and its place in the queue.

import { listQuarantine, replayQuarantine, countPending } from '../src/sync/quarantine.js'
import { closePool } from '../src/db/postgres.js'

const run = async () => {
  const retry = process.argv.includes('--retry')
  const pending = await countPending()

  if (pending === 0) {
    console.log('Nothing quarantined — every record sync saw went in.')
    return
  }

  if (!retry) {
    const { items } = await listQuarantine({ limit: 20, offset: 0 })
    console.log(`${pending} record(s) waiting:\n`)
    for (const r of items)
      console.log(
        `  [${r.id}] ${r.stage}  ${r.filePath}${r.lineNumber ? `:${r.lineNumber}` : ''}\n` +
          `        ${r.error}\n` +
          `        ${r.attempts} attempt(s), first seen ${r.firstSeenAt}`
      )
    if (pending > items.length) console.log(`\n  …and ${pending - items.length} more.`)
    console.log('\nRun with --retry to replay them.')
    return
  }

  const result = await replayQuarantine({ limit: 500 })
  console.log(`Attempted ${result.attempted}, recovered ${result.recovered}.`)
  for (const outcome of result.outcomes.filter(o => !o.ok))
    console.log(`  [${outcome.id}] still failing: ${outcome.error}`)
  console.log(`${await countPending()} still pending.`)
}

run()
  .catch(e => {
    console.error('Quarantine command failed:', e)
    process.exitCode = 1
  })
  .finally(closePool)
