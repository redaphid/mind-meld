import { query, closePool } from '../../src/db/postgres.js';

(async () => {
  // Check for sessions with messages but null timestamps
  const result = await query(`
    SELECT
      s.id,
      s.external_id,
      s.started_at,
      s.ended_at,
      COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE (s.started_at IS NULL OR s.ended_at IS NULL)
      AND m.id IS NOT NULL
    GROUP BY s.id, s.external_id, s.started_at, s.ended_at
    ORDER BY message_count DESC
    LIMIT 10
  `);

  console.log('Sessions with messages but missing timestamps:', result.rows.length);
  if (result.rows.length > 0) {
    console.log('\nSample sessions:');
    result.rows.forEach(row => {
      console.log(`  - Session ${row.external_id}: ${row.message_count} messages, started_at=${row.started_at}, ended_at=${row.ended_at}`);
    });
  } else {
    console.log('✅ All sessions with messages have valid timestamps!');
  }

  await closePool();
})();
