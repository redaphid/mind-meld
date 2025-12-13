import { ChromaClient } from "chromadb"

const main = async () => {
  const client = new ChromaClient({ path: "http://localhost:8001" })
  const collection = await client.getCollection({ name: "convo-sessions" })

  // Get a sample of sessions
  const result = await collection.get({
    limit: 10,
    include: ["documents", "metadatas"]
  })

  console.log(`Total sessions: ${result.ids.length}\n`)

  for (let i = 0; i < result.ids.length; i++) {
    console.log(`=== Session ${result.ids[i]} ===`)
    console.log("Project:", result.metadatas?.[i]?.project_path)
    console.log("Title:", result.metadatas?.[i]?.title)
    console.log("Document length:", result.documents?.[i]?.length || 0)
    console.log("Document preview:", result.documents?.[i]?.slice(0, 200))
    console.log()
  }
}

main()
