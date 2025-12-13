import { ChromaClient } from "chromadb"
import { Ollama } from "ollama"

const main = async () => {
  const ollama = new Ollama({ host: "http://localhost:11434" })

  // Generate embedding for "storefronts"
  console.log("Generating embedding for 'storefronts'...")
  const response = await ollama.embed({
    model: "bge-m3",
    input: "storefronts"
  })
  const queryEmbedding = response.embeddings[0]

  // Query Chroma with this embedding
  const client = new ChromaClient({ path: "http://localhost:8001" })
  const collection = await client.getCollection({ name: "convo-sessions" })

  console.log("\nSearching Chroma for similar sessions...")
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: 20,
    include: ["documents", "metadatas", "distances"]
  })

  console.log(`\nFound ${results.ids[0].length} results:\n`)

  for (let i = 0; i < results.ids[0].length; i++) {
    const id = results.ids[0][i]
    const distance = results.distances?.[0]?.[i]
    const meta = results.metadatas?.[0]?.[i]
    const doc = results.documents?.[0]?.[i]

    console.log(`${i + 1}. ${id} (distance: ${distance?.toFixed(4)})`)
    console.log(`   Project: ${meta?.project_path}`)
    console.log(`   Title: ${meta?.title?.slice(0, 100)}`)

    // Check if doc mentions storefront
    const hasStorefront = doc?.toLowerCase().includes('storefront')
    console.log(`   Has 'storefront': ${hasStorefront ? 'YES' : 'no'}`)
    console.log(`   Doc preview: ${doc?.slice(0, 150)}`)
    console.log()
  }
}

main()
