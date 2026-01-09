import { query } from '../../src/db/postgres.js';
import { closePool } from '../../src/db/postgres.js';
import { config } from '../../src/config.js';

async function findProblematicSessions() {
  console.log('Checking for sessions that would produce NaN in metadata...\n');

  // Get sessions that need embedding (same query as updateAggregateEmbeddings)
  const sessions = await query<{
    id: number;
    external_id: string;
    title: string;
    project_path: string;
    source_name: string;
    message_count: number;
    total_tokens: number;
    content_chars: number;
    started_at: Date | null;
    existing_content_chars: number | null;
  }>(
    `SELECT s.id, s.external_id, s.title, p.path as project_path, src.name as source_name,
            s.message_count, s.total_input_tokens + s.total_output_tokens as total_tokens,
            s.content_chars, s.started_at,
            e.content_chars_at_embed as existing_content_chars
     FROM sessions s
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     LEFT JOIN embeddings e ON e.chroma_collection = $1 AND e.chroma_id = 'session-' || s.id::text
     WHERE s.message_count > 0
       AND s.title != 'Warmup'
       AND (
         e.id IS NULL
         OR s.content_chars > COALESCE(e.content_chars_at_embed, 0)
         OR COALESCE(s.content_chars, 0) = 0
       )
     LIMIT 200`,
    [config.chroma.collections.sessions]
  );

  console.log(`Found ${sessions.rows.length} sessions that need embedding\n`);

  let problemCount = 0;

  for (const session of sessions.rows) {
    const metadata = {
      source: session.source_name,
      project_path: session.project_path,
      session_id: session.external_id,
      title: session.title ?? '',
      started_at: session.started_at?.getTime() ?? Date.now(),
      message_count: session.message_count,
      total_tokens: session.total_tokens,
      content_chars: session.content_chars,
      embedded_at: Date.now(),
    };

    // Check each numeric field for NaN
    const nanFields: string[] = [];
    Object.entries(metadata).forEach(([key, value]) => {
      if (typeof value === 'number' && (isNaN(value) || !isFinite(value))) {
        nanFields.push(`${key}=${value}`);
      }
    });

    if (nanFields.length > 0) {
      problemCount++;
      console.log(`❌ Session ${session.id} (${session.external_id}) has NaN fields:`);
      console.log(`   Title: ${session.title}`);
      console.log(`   NaN fields: ${nanFields.join(', ')}`);
      console.log(`   started_at (raw): ${session.started_at}`);
      console.log(`   started_at type: ${typeof session.started_at}`);
      console.log(`   message_count: ${session.message_count} (type: ${typeof session.message_count})`);
      console.log(`   total_tokens: ${session.total_tokens} (type: ${typeof session.total_tokens})`);
      console.log(`   content_chars: ${session.content_chars} (type: ${typeof session.content_chars})`);
      console.log('');
    }
  }

  if (problemCount === 0) {
    console.log('✅ No sessions with NaN values found!');
  } else {
    console.log(`\n Found ${problemCount} problematic sessions`);
  }
}

findProblematicSessions()
  .then(() => closePool())
  .catch((e) => {
    console.error('Error:', e);
    closePool();
    process.exit(1);
  });
