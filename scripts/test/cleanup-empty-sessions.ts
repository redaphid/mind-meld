import { query, closePool } from '../../src/db/postgres.js';

(async () => {
  console.log('=== Cleaning Up Empty Sessions ===\n');

  // Count sessions without messages
  const count = await query(`
    SELECT COUNT(DISTINCT s.id) as count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE m.id IS NULL
  `);

  console.log(`Found ${count.rows[0].count} sessions without messages`);

  if (count.rows[0].count > 0) {
    console.log('\nDeleting empty sessions...');

    const result = await query(`
      DELETE FROM sessions
      WHERE id IN (
        SELECT s.id
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        WHERE m.id IS NULL
      )
    `);

    console.log(`✅ Deleted ${result.rowCount} empty sessions`);
  }

  await closePool();
})();
