import { ChromaClient } from "chromadb"

const main = async () => {
  const client = new ChromaClient({ path: "http://localhost:8001" })
  const collection = await client.getCollection({ name: "convo-sessions" })

  // Check if session-183550 exists
  const result = await collection.get({
    ids: ["session-183550", "session-104057"],
    include: ["documents", "metadatas"]
  })

  console.log("Found sessions:", result.ids.length)

  for (let i = 0; i < result.ids.length; i++) {
    console.log(`\n=== ${result.ids[i]} ===`)
    console.log("Title:", result.metadatas?.[i]?.title)
    console.log("Project:", result.metadatas?.[i]?.project_path)
    console.log("Document length:", result.documents?.[i]?.length)
    console.log("Document:", result.documents?.[i])
  }
}

main()
