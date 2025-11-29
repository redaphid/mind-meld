import { ChromaClient } from "chromadb";
import { generateEmbeddings } from "../../src/embeddings/ollama.js";

async function search(query: string, limit = 5) {
  const client = new ChromaClient({ path: "http://localhost:8001" });
  const collection = await client.getCollection({ name: "convo-messages" });

  const [embedding] = await generateEmbeddings([query]);

  const results = await collection.query({
    queryEmbeddings: [embedding],
    nResults: limit,
    include: ["documents", "metadatas", "distances"]
  });

  console.log(`\n=== "${query}" ===\n`);
  for (let i = 0; i < results.ids[0].length; i++) {
    const meta = results.metadatas?.[0]?.[i] as Record<string, unknown>;
    const doc = results.documents?.[0]?.[i];
    const dist = results.distances?.[0]?.[i];
    const proj = (meta?.project_path as string)?.split('/').slice(-2).join('/');
    console.log(`[${i+1}] Distance: ${dist?.toFixed(4)} | ${meta?.role} | ${proj}`);
    console.log(`    ${doc?.slice(0, 180).replace(/\n/g, ' ')}...\n`);
  }
}

const queries = [
  "graphql mutations and queries",
  "MCP server implementation model context protocol",
  "cloudflare workers deployment wrangler",
  "docker compose postgres database",
  "react component state management"
];

for (const q of queries) {
  await search(q);
}
