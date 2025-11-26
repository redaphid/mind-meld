import { query, closePool } from "../src/db/postgres.js";
import { ChromaClient } from "chromadb";

async function stats() {
  console.log("\n=== Mindmeld Statistics ===\n");

  // Detailed breakdown by source
  const bySource = await query<{ source: string; projects: number; sessions: number; messages: number }>(`
    SELECT
      src.name as source,
      COUNT(DISTINCT p.id) as projects,
      COUNT(DISTINCT s.id) as sessions,
      COUNT(DISTINCT m.id) as messages
    FROM sources src
    LEFT JOIN projects p ON p.source_id = src.id
    LEFT JOIN sessions s ON s.project_id = p.id
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY src.name
    ORDER BY messages DESC
  `);
  console.log("By Source:");
  console.log("  Source           Projects   Sessions   Messages");
  console.log("  ─────────────────────────────────────────────────");
  for (const s of bySource.rows) {
    console.log(`  ${s.source.padEnd(15)} ${String(s.projects).padStart(10)} ${String(s.sessions).padStart(10)} ${String(s.messages).padStart(10)}`);
  }

  // Projects
  const projects = await query<{ count: number }>(`SELECT COUNT(*) as count FROM projects`);
  console.log(`\nTotal Projects: ${projects.rows[0].count}`);

  // Sessions
  const sessions = await query<{ count: number }>(`SELECT COUNT(*) as count FROM sessions`);
  console.log(`Sessions: ${sessions.rows[0].count}`);

  // Messages
  const messages = await query<{ count: number }>(`SELECT COUNT(*) as count FROM messages`);
  console.log(`Messages: ${messages.rows[0].count}`);

  // Messages by role
  const byRole = await query<{ role: string; count: number }>(`
    SELECT role, COUNT(*) as count FROM messages GROUP BY role ORDER BY count DESC
  `);
  console.log("\nMessages by role:");
  for (const r of byRole.rows) {
    console.log(`  ${r.role}: ${r.count}`);
  }

  // Embeddings in PostgreSQL
  const embeddings = await query<{ count: number }>(`SELECT COUNT(*) as count FROM embeddings`);
  console.log(`\nPostgreSQL embeddings records: ${embeddings.rows[0].count}`);

  // Chroma stats
  try {
    const client = new ChromaClient({ path: "http://localhost:8001" });
    const collection = await client.getCollection({ name: "convo-messages" });
    const count = await collection.count();
    console.log(`Chroma vectors: ${count}`);
  } catch (e) {
    console.log(`Chroma: unavailable`);
  }

  // Top projects by message count
  const topProjects = await query<{ path: string; count: number }>(`
    SELECT p.path, COUNT(m.id) as count
    FROM projects p
    JOIN sessions s ON s.project_id = p.id
    JOIN messages m ON m.session_id = s.id
    GROUP BY p.path
    ORDER BY count DESC
    LIMIT 10
  `);
  console.log("\nTop 10 projects by messages:");
  for (const p of topProjects.rows) {
    const short = p.path.split("/").slice(-2).join("/");
    console.log(`  ${short}: ${p.count}`);
  }

  // Recent activity
  const recent = await query<{ date: string; count: number }>(`
    SELECT DATE(timestamp) as date, COUNT(*) as count
    FROM messages
    WHERE timestamp > NOW() - INTERVAL '7 days'
    GROUP BY DATE(timestamp)
    ORDER BY date DESC
  `);
  console.log("\nLast 7 days activity:");
  for (const r of recent.rows) {
    console.log(`  ${r.date}: ${r.count} messages`);
  }

  await closePool();
}

stats().catch(console.error);
