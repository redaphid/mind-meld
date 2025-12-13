import { ChromaClient } from "chromadb"
import { Ollama } from "ollama"

const main = async () => {
  const ollama = new Ollama({ host: "http://localhost:11434" })

  console.log("Generating embedding for 'storefronts app'...")
  const response = await ollama.embed({
    model: "bge-m3",
    input: "storefronts app sibi application development"
  })
  const queryEmbedding = response.embeddings[0]

  const client = new ChromaClient({ path: "http://localhost:8001" })
  const collection = await client.getCollection({ name: "convo-sessions" })

  console.log("\nSearching for sessions 104057 and 183550...")
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: 100,
    include: ["metadatas", "distances"]
  })

  // Find the positions of our target sessions
  const targetSessions = ["session-104057", "session-183550"]

  for (const targetId of targetSessions) {
    const index = results.ids[0].indexOf(targetId)
    if (index >= 0) {
      console.log(`\n${targetId}: Position ${index + 1} (distance: ${results.distances?.[0]?.[index].toFixed(4)})`)
      console.log(`  Title: ${results.metadatas?.[0]?.[index]?.title}`)
    } else {
      console.log(`\n${targetId}: NOT in top 100`)
    }
  }

  // Count warmup sessions in top 100
  const warmupCount = results.ids[0].filter((id, i) =>
    results.metadatas?.[0]?.[i]?.title === 'Warmup'
  ).length

  console.log(`\nWarmup sessions in top 100: ${warmupCount}`)
}

main()
