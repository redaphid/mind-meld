import { ChromaClient } from "chromadb"

const main = async () => {
  const client = new ChromaClient({ path: "http://localhost:8001" })
  const collection = await client.getCollection({ name: "convo-messages" })

  // Get a batch with known-missing IDs
  const result = await collection.get({
    ids: ["msg-999999999", "msg-1", "msg-2"],
    include: ["metadatas"]
  })

  console.log("Result for mixed IDs:", JSON.stringify(result, null, 2))
  console.log("\nIDs returned:", result.ids.length)
  console.log("Metadatas returned:", result.metadatas?.length ?? 0)
}

main()
