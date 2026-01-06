import { query } from '../../src/db/postgres.js'

interface Message {
  sequence_num: number
  role: string
  content_text: string | null
  content_json: any | null
  timestamp: Date
  model: string | null
  tool_name: string | null
}

interface Session {
  id: number
  external_id: string
  title: string
  project_path: string
  source_name: string
  started_at: Date
  message_count: number
}

const getSessionTranscript = async (searchTerm: string) => {
  // Try to find session by external_id first, then by title search
  const sessionResult = await query<Session>(
    `SELECT s.id, s.external_id, s.title, p.path as project_path,
            src.name as source_name, s.started_at, s.message_count
     FROM sessions s
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE s.external_id = $1
        OR s.title ILIKE $2
     ORDER BY s.started_at DESC
     LIMIT 1`,
    [searchTerm, `%${searchTerm}%`]
  )

  if (sessionResult.rows.length === 0) {
    console.error(`No session found matching: ${searchTerm}`)
    process.exit(1)
  }

  const session = sessionResult.rows[0]

  // Get all messages for this session
  const messagesResult = await query<Message>(
    `SELECT sequence_num, role, content_text, content_json, timestamp, model, tool_name
     FROM messages
     WHERE session_id = $1
     ORDER BY sequence_num`,
    [session.id]
  )

  // Print session header
  console.log('='.repeat(80))
  console.log(`Session: ${session.title}`)
  console.log(`ID: ${session.external_id}`)
  console.log(`Source: ${session.source_name}`)
  console.log(`Project: ${session.project_path}`)
  console.log(`Started: ${session.started_at.toLocaleString()}`)
  console.log(`Messages: ${session.message_count}`)
  console.log('='.repeat(80))
  console.log()

  // Print messages
  for (const msg of messagesResult.rows) {
    const timestamp = msg.timestamp.toLocaleTimeString()
    const roleLabel = msg.role.toUpperCase().padEnd(10)
    const model = msg.model ? ` [${msg.model}]` : ''
    const tool = msg.tool_name ? ` (tool: ${msg.tool_name})` : ''

    console.log(`[${timestamp}] ${roleLabel}${model}${tool}`)

    if (msg.content_text) {
      // Indent content for readability
      const lines = msg.content_text.split('\n')
      for (const line of lines) {
        console.log(`  ${line}`)
      }
    } else if (msg.content_json) {
      console.log(`  [JSON content]`)
    }

    console.log() // Blank line between messages
  }

  process.exit(0)
}

const searchTerm = process.argv[2]

if (!searchTerm) {
  console.error('Usage: tsx scripts/test/get-session-transcript.ts <session-id-or-search-term>')
  console.error('')
  console.error('Examples:')
  console.error('  tsx scripts/test/get-session-transcript.ts abc123def456')
  console.error('  tsx scripts/test/get-session-transcript.ts "moonlight crashing"')
  process.exit(1)
}

getSessionTranscript(searchTerm).catch(console.error)
