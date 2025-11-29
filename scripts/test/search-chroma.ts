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
    console.log(`[${i+1}] ${dist?.toFixed(3)} | ${meta?.role} | ${proj}`);
    console.log(`    ${doc?.slice(0, 160).replace(/\n/g, ' ')}...\n`);
  }
}

const queries = [
  // Technical topics
  "authentication JWT tokens OAuth login",
  "debugging errors stack trace exceptions",
  "typescript type definitions interfaces generics",
  "git commit push merge rebase",
  "API endpoint REST HTTP request response",

  // Sibi/Business context
  "HVAC heating cooling installation replacement",
  "property management real estate landlord tenant",
  "warranty claim service repair",
  "order fulfillment delivery shipping",

  // Infrastructure
  "vector embeddings semantic search similarity",
  "database migration schema changes",
  "environment variables secrets configuration",
  "websocket real-time streaming events",

  // Tools and frameworks
  "Ollama LLM local model inference",
  "ChromaDB vector database collection",
  "Linear issues tickets sprint",
  "Slack messages channels notifications",
];

for (const q of queries) {
  await search(q, 3);
}

// Stats
const client = new ChromaClient({ path: "http://localhost:8001" });
const collection = await client.getCollection({ name: "convo-messages" });
const count = await collection.count();
console.log(`\n=== Total embeddings: ${count} ===`);
