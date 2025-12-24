import { query, closePool } from '../../src/db/postgres.js';

(async () => {
  const result = await query(`
    SELECT
      COUNT(*) as total_sessions,
      COUNT(*) FILTER (WHERE file_modified_at > NOW() - INTERVAL '1 hour') as synced_recently,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id IN (
        SELECT s.id FROM sessions s WHERE s.project_id IN (
          SELECT id FROM projects WHERE source_id = (SELECT id FROM sources WHERE name = 'cursor')
        )
      )) as total_messages
    FROM sessions s
    WHERE project_id IN (
      SELECT id FROM projects WHERE source_id = (SELECT id FROM sources WHERE name = 'cursor')
    )
  `);

  console.log('Cursor Stats:');
  console.log('Total sessions:', result.rows[0].total_sessions);
  console.log('Synced in last hour:', result.rows[0].synced_recently);
  console.log('Total messages:', result.rows[0].total_messages);

  await closePool();
})();
