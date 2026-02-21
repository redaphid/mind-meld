# Mindmeld Usage Guide

## Search Examples

### Basic Semantic Search

Find conversations about a topic, even when exact keywords don't match:

```typescript
{ query: "authentication and security patterns", limit: 10 }
// Finds OAuth, JWT, session handling discussions even without those keywords
```

### Project-Aware Search

Boost results from your current project:

```typescript
{
  query: "database optimization strategies",
  cwd: "/Users/you/Projects/my-app",
  projectOnly: true  // Only search this project
}
```

### Time-Range Filtering

```typescript
{ query: "API error handling", since: "7d" }
```

### Weighted Centroid Search

Find conversations similar to specific sessions or projects:

```typescript
{
  query: "storefronts implementation",
  likeSession: ["12345:1.5"],        // 1.5x boost for this style
  unlikeSession: ["briefing:0.5"],   // Suppress this style
}
```

### Negative Query (Disambiguation)

```typescript
{ query: "workers", negativeQuery: "employees HR hiring" }
// Finds Cloudflare Workers, not people
```

### Source Filtering

```typescript
{ query: "refactoring patterns", source: "claude_code" }
```

## MCP Tools Reference

### `search`

Search conversations with semantic ranking.

**Parameters:**
- `query` (string): Natural language search query
- `limit` (number, optional): Max results (default: 20)
- `cwd` (string, optional): Current directory — boosts matching projects
- `projectOnly` (boolean, optional): Only search current project
- `since` (string, optional): Time range filter (e.g. "7d", "2024-01-01")
- `source` (enum, optional): "claude_code" or "cursor"
- `likeSession` / `unlikeSession` (string[], optional): Weighted session centroids
- `likeProject` / `unlikeProject` (string[], optional): Weighted project centroids
- `negativeQuery` (string, optional): Semantic exclusion terms
- `excludeTerms` (string, optional): Exclude results matching these terms
- `mode` (enum, optional): "semantic" (default), "text", or "hybrid"

Returns markdown-formatted results with session ID, title, summary, score, source, project, timestamp, and message count.

### `getSession`

Retrieve full conversation with all messages and tool calls.

**Parameters:**
- `sessionId` (number): Session ID from search results
- `limit` (number, optional): Max messages to return (default: 50)
- `offset` (number, optional): Pagination offset

Returns markdown-formatted session metadata and messages.

### `stats`

Get overview statistics — session and message counts by source, top projects.

No parameters.

## Data Flow

1. **Sync** (every hour):
   - Scans `~/.claude/projects/` for new/modified JSONL files
   - Reads Cursor conversations from `state.vscdb` in globalStorage
   - Extracts messages, metadata, tool calls
   - Inserts into PostgreSQL with incremental progress tracking

2. **Embedding Generation**:
   - Queries pending messages from PostgreSQL
   - Generates embeddings via Ollama (local, batches of 100)
   - Upserts into ChromaDB collections
   - Updates PostgreSQL with embedding IDs

3. **Centroid Computation** (every 7 hours):
   - Averages message embeddings per session/project
   - Stores centroids in separate ChromaDB collections
   - Enables weighted semantic search

## Workflow Examples

### Find Similar Past Work

```typescript
// You're implementing auth — find how you solved this before
{ query: "implementing OAuth2 with refresh tokens", cwd: "/Users/you/Projects/new-auth-service", limit: 5 }

// Then retrieve the full conversation
{ sessionId: 104057 }  // from search results
```

### Catch Up on Recent Project Context

```typescript
{
  query: "API endpoints error handling",
  cwd: "/Users/you/Projects/api-gateway",
  since: "7d",
  projectOnly: true
}
```
