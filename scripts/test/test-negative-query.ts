import { ChromaClient } from "chromadb"
import { Ollama } from "ollama"
import { subtractVectors, normalizeVector } from "../../src/utils/vector-math.js"

const main = async () => {
  const ollama = new Ollama({ host: "http://localhost:11434" })
  const client = new ChromaClient({ path: "http://localhost:8001" })
  const collection = await client.getCollection({ name: "convo-sessions" })

  const query = "storefronts app development"
  const negativeQuery = "slack briefing discussion summaries"

  console.log("=== TEST 1: Normal search for 'storefronts' ===\n")
  const response1 = await ollama.embed({
    model: "bge-m3",
    input: query
  })
  const embedding1 = response1.embeddings[0]

  const results1 = await collection.query({
    queryEmbeddings: [embedding1],
    nResults: 10,
    include: ["metadatas", "distances"]
  })

  for (let i = 0; i < Math.min(5, results1.ids[0].length); i++) {
    const meta = results1.metadatas?.[0]?.[i]
    const distance = results1.distances?.[0]?.[i]
    console.log(`${i + 1}. ${results1.ids[0][i]} (distance: ${distance?.toFixed(4)})`)
    console.log(`   Project: ${meta?.project_path}`)
    console.log(`   Title: ${meta?.title?.slice(0, 80)}`)
    console.log()
  }

  console.log("\n=== TEST 2: With negative query (excluding Slack briefings) ===\n")

  const response2 = await ollama.embed({
    model: "bge-m3",
    input: negativeQuery
  })
  const negativeEmbedding = response2.embeddings[0]

  let composedVector = subtractVectors(embedding1, negativeEmbedding)
  composedVector = normalizeVector(composedVector)

  const results2 = await collection.query({
    queryEmbeddings: [composedVector],
    nResults: 10,
    include: ["metadatas", "distances"]
  })

  for (let i = 0; i < Math.min(5, results2.ids[0].length); i++) {
    const meta = results2.metadatas?.[0]?.[i]
    const distance = results2.distances?.[0]?.[i]
    console.log(`${i + 1}. ${results2.ids[0][i]} (distance: ${distance?.toFixed(4)})`)
    console.log(`   Project: ${meta?.project_path}`)
    console.log(`   Title: ${meta?.title?.slice(0, 80)}`)
    console.log()
  }

  // Check if session-104057 or session-183550 appear in results
  console.log("\n=== Target Sessions Ranking ===")
  const targets = ["session-104057", "session-183550"]

  for (const target of targets) {
    const idx1 = results1.ids[0].indexOf(target)
    const idx2 = results2.ids[0].indexOf(target)
    console.log(`\n${target}:`)
    console.log(`  Without negative: ${idx1 >= 0 ? `position ${idx1 + 1}` : 'not in top 10'}`)
    console.log(`  With negative: ${idx2 >= 0 ? `position ${idx2 + 1}` : 'not in top 10'}`)
  }
}

main()
