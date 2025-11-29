import { ChromaClient } from "chromadb";

async function main() {
  const client = new ChromaClient({ path: "http://localhost:8001" });
  // Check sessions collection - that's where conversation summarization happens
  const collection = await client.getCollection({ name: "convo-sessions" });

  // Get sessions where was_summarized = true (to find summarized ones)
  const result = await collection.get({
    where: { was_summarized: true },
    include: ["documents", "metadatas"],
    limit: 100,
  });

  console.log(`Found ${result.ids.length} sessions with ~30k content_chars\n`);

  // Show all - sessions with was_summarized=true are the summarized ones
  for (let i = 0; i < result.ids.length; i++) {
    const doc = result.documents?.[i];
    const meta = result.metadatas?.[i];
    const contentChars = meta?.content_chars as number;
    const docLen = doc?.length ?? 0;
    const wasSummarized = meta?.was_summarized as boolean;

    console.log(`=== ${result.ids[i]} ===`);
    console.log(`Original content_chars: ${contentChars}`);
    console.log(`Document length: ${docLen} chars`);
    console.log(`Was summarized: ${wasSummarized}`);
    console.log(`Compression: ${((1 - docLen / contentChars) * 100).toFixed(1)}%`);
    console.log(`Project: ${meta?.project_path}`);
    console.log(`Title: ${meta?.title}`);
    console.log(`\nDOCUMENT CONTENT:\n${doc}\n`);
    console.log("─".repeat(80));
  }
}

main().catch(console.error);
