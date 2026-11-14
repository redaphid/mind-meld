import { runMigrations } from '../src/db/migrations.js'
import { config } from '../src/config.js'

runMigrations(config.postgres)
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Migration failed:', error)
    process.exit(1)
  })
