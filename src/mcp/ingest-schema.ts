// The wire shape of POST /api/ingest — and nothing else. This lives apart
// from ingest.ts so the edge acceptor (mcp-gateway/, a Cloudflare Worker) can
// import the exact schema the host will enforce at drain time, without
// dragging the Postgres client into a Worker bundle. One definition, both
// sides — the same rule that put the pending-count predicate in
// src/embeddings/pending.ts.
import { z } from 'zod'

const IngestMessageSchema = z.object({
  externalId: z.string(),
  role: z.string(),
  content: z.string(),
  timestamp: z.string().transform(s => new Date(s)),
  sequenceNum: z.number(),
  metadata: z.record(z.unknown()).optional(),
})

export const IngestPayloadSchema = z.object({
  source: z.string(),
  sourceDisplayName: z.string().optional(),
  // Classification for the source ('coding' | 'personal' | 'meetings' | ...,
  // open vocabulary). REQUIRED when the ingest would create a new source —
  // enforced in ingestConversation, where we can see whether the source
  // exists. An existing source keeps its current class regardless of what is
  // sent. Normalized like the search side: a source stamped "Coding " would
  // be unreachable.
  dataClass: z
    .string()
    .max(32)
    .optional()
    .transform(s => s?.trim().toLowerCase() || undefined),
  // The sending computer. Omitted means "unknown" — we record nothing rather
  // than mislabelling it as the machine running this server.
  machine: z.string().max(64).optional(),
  // The sending computer's operating system (#33): `win32` | `wsl` | `linux`
  // | `darwin` | … Same rule as `machine` — omitted means "unknown" and is
  // recorded as null, because a relayed thread did not come from this
  // server's OS. It is the fact that makes a `/mnt/<letter>` path comparison
  // sound rather than assumed, so guessing it would be worse than lacking it.
  os: z.string().max(32).optional(),
  project: z.object({
    externalId: z.string(),
    name: z.string(),
    path: z.string().optional(),
  }),
  session: z.object({
    externalId: z.string(),
    title: z.string(),
    startedAt: z.string().transform(s => new Date(s)),
    endedAt: z.string().transform(s => new Date(s)).optional(),
  }),
  messages: z.array(IngestMessageSchema),
})

export type IngestPayload = z.infer<typeof IngestPayloadSchema>
