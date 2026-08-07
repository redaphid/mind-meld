// Drains the edge ingest spool: conversations POSTed to the mcp-gateway
// Worker (mcp-gateway/src/index.ts, the /ingest routes) while this host was
// down, unreachable, or simply between sync cycles. The spool exists because
// push ingestion had the one data-loss window file sync never had — a
// producer that fires once at a dead origin has nowhere durable to put the
// conversation. The Worker accepts into R2; this drains R2 into Postgres.
//
// All R2 access is mediated by the Worker (list/fetch/acknowledge under
// /ingest/<service>/spool), so the host needs no Cloudflare credentials —
// just an Access service token, the same kind of secret every other machine
// in this system already holds.
//
// Failure semantics mirror file sync:
//  - A payload that fails to parse or insert is quarantined WHOLE into
//    sync_quarantine and then removed from the spool: visible, counted,
//    replayable with `pnpm run quarantine -- --retry`, never retried blindly
//    every cycle.
//  - If even the quarantine write fails (Postgres down), the object stays in
//    the spool and the error is recorded — the next cycle retries. Nothing
//    is dropped in either direction.
//  - Several workers may drain concurrently (the same unclaimed-queue shape
//    as embeddings): a GET that 404s mid-drain just means another worker won
//    that object. Ingest is upsert-keyed on external ids, so double-draining
//    wastes a little work and corrupts nothing.
import { IngestPayloadSchema } from '../mcp/ingest-schema.js'
import { ingestConversation } from '../mcp/ingest.js'
import { quarantine, SPOOL_QUARANTINE_SOURCE } from './quarantine.js'

export interface SpoolDrainStats {
  // False when the spool env vars are absent — a machine without a spool
  // configured is a normal machine, not a failing one.
  configured: boolean
  drained: number
  quarantined: number
  errors: string[]
}

const spoolConfig = () => {
  const url = process.env.INGEST_SPOOL_URL
  const clientId = process.env.INGEST_SPOOL_CLIENT_ID
  const clientSecret = process.env.INGEST_SPOOL_CLIENT_SECRET
  if (!url || !clientId || !clientSecret) return null
  return {
    url: url.replace(/\/+$/, ''),
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
  }
}

type SpoolListing = { keys: { id: string }[]; truncated: boolean }

export const drainIngestSpool = async (): Promise<SpoolDrainStats> => {
  const stats: SpoolDrainStats = { configured: false, drained: 0, quarantined: 0, errors: [] }
  const cfg = spoolConfig()
  if (!cfg) return stats
  stats.configured = true

  // The listing is re-fetched until it comes back empty or a pass makes no
  // progress, so a truncated first page does not leave the tail for next
  // cycle. The no-progress guard is what keeps a persistently failing object
  // from turning this loop infinite.
  while (true) {
    let listing: SpoolListing
    try {
      const res = await fetch(`${cfg.url}/spool`, { headers: cfg.headers })
      if (!res.ok) {
        stats.errors.push(`ingest spool list failed: HTTP ${res.status}`)
        return stats
      }
      listing = (await res.json()) as SpoolListing
    } catch (e) {
      stats.errors.push(`ingest spool unreachable: ${e}`)
      return stats
    }

    if (listing.keys.length === 0) return stats
    let progressed = false

    for (const { id } of listing.keys) {
      let raw: string
      try {
        const res = await fetch(`${cfg.url}/spool/${id}`, { headers: cfg.headers })
        // Another worker drained it between the list and the get. Theirs now.
        if (res.status === 404) continue
        if (!res.ok) {
          stats.errors.push(`ingest spool fetch of ${id} failed: HTTP ${res.status}`)
          continue
        }
        raw = await res.text()
      } catch (e) {
        // Transport died mid-drain; the rest of the page will fail the same
        // way, so stop here rather than recording one error per object.
        stats.errors.push(`ingest spool unreachable: ${e}`)
        return stats
      }

      // Stage is where it actually threw: 'parse' covers JSON and schema,
      // 'insert' covers ingestConversation (a semantic rule like a new source
      // without a dataClass, or the database refusing a row).
      let failure: { stage: 'parse' | 'insert'; error: unknown } | null = null
      try {
        const payload = IngestPayloadSchema.parse(JSON.parse(raw))
        try {
          await ingestConversation(payload)
          stats.drained++
        } catch (e) {
          failure = { stage: 'insert', error: e }
        }
      } catch (e) {
        failure = { stage: 'parse', error: e }
      }

      let done = failure === null
      if (failure) {
        // The payload is the problem. Preserve it whole; only a *confirmed*
        // quarantine write earns removal from the spool — quarantine()
        // returning null means Postgres is the problem instead, and the
        // object must wait where it is.
        const quarantineId = await quarantine({
          source: SPOOL_QUARANTINE_SOURCE,
          filePath: cfg.url,
          recordKey: id,
          stage: failure.stage,
          payload: raw,
          error: failure.error,
        })
        if (quarantineId === null) {
          stats.errors.push(
            `ingest spool payload ${id} failed and could not be quarantined: ${failure.error}`
          )
        } else {
          stats.quarantined++
          done = true
        }
      }

      if (done) {
        try {
          const res = await fetch(`${cfg.url}/spool/${id}`, { method: 'DELETE', headers: cfg.headers })
          if (!res.ok && res.status !== 404) {
            // The data is safe (ingested or quarantined); a failed
            // acknowledge only means a wasted re-ingest next cycle, which the
            // upsert keys absorb. Recorded so a persistent delete failure is
            // visible rather than a silent doubling of work.
            stats.errors.push(`ingest spool acknowledge of ${id} failed: HTTP ${res.status}`)
          } else {
            progressed = true
          }
        } catch (e) {
          stats.errors.push(`ingest spool unreachable: ${e}`)
          return stats
        }
      }
    }

    if (!progressed) return stats
  }
}
