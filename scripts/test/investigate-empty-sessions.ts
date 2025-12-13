import { query, closePool } from '../../src/db/postgres.js';

(async () => {
  console.log('=== Investigating Sessions Without Messages ===\n');

  // Get count and sample
  const result = await query(`
    SELECT
      s.id,
      s.external_id,
      s.title,
      s.started_at,
      s.ended_at,
      s.raw_file_path,
      s.file_modified_at,
      src.name as source_name,
      p.name as project_name
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN sources src ON p.source_id = src.id
    WHERE m.id IS NULL
    ORDER BY s.file_modified_at DESC NULLS LAST
    LIMIT 20
  `);

  console.log(`Total sessions without messages: ${result.rows.length > 0 ? 'at least 20' : '0'}`);

  if (result.rows.length > 0) {
    console.log('\nSample sessions:');
    result.rows.forEach((row, i) => {
      console.log(`\n${i + 1}. Session ${row.external_id}`);
      console.log(`   Source: ${row.source_name}`);
      console.log(`   Project: ${row.project_name}`);
      console.log(`   Title: ${row.title || '(none)'}`);
      console.log(`   File: ${row.raw_file_path || '(none)'}`);
      console.log(`   Modified: ${row.file_modified_at || '(none)'}`);
    });

    // Check if files still exist
    console.log('\n=== File Existence Check ===');
    const withFiles = result.rows.filter(r => r.raw_file_path);
    console.log(`Sessions with file paths: ${withFiles.length}/${result.rows.length}`);
  }

  // Group by source
  const bySource = await query(`
    SELECT
      src.name as source_name,
      COUNT(DISTINCT s.id) as session_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN sources src ON p.source_id = src.id
    WHERE m.id IS NULL
    GROUP BY src.name
  `);

  console.log('\n=== By Source ===');
  bySource.rows.forEach(row => {
    console.log(`  ${row.source_name}: ${row.session_count} sessions`);
  });

  await closePool();
})();
