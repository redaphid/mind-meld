/**
 * Merge duplicate project rows created by the lossy project-dir decoding.
 *
 * The same logical project can exist as multiple rows — e.g. `sporefall-art`
 * synced from WSL (`-home-...-projects-sporefall-art`) and again from Windows
 * (`D--Projects-sporefall-art`). This script:
 *
 *   1. Computes a canonical path per project: the most common session cwd when
 *      available (immune to hyphen lossiness), else the stored path run through
 *      the fixed decodeProjectPath.
 *   2. Groups projects within the SAME source whose canonical name matches
 *      case-insensitively AND whose paths' last segment matches. A second,
 *      conservative pass folds in encoded-path projects without any session cwd
 *      (whose decode is hyphen-lossy) when their encoded dir name unambiguously
 *      ends with exactly one group's name.
 *   3. Keeps the lowest-id row, re-points sessions and history_entries,
 *      deletes the orphaned rows.
 *
 * Guards:
 *   - Never merges into/out of a project named exactly 'Projects'/'projects'
 *     (the ~/Projects catch-all).
 *   - UNIQUE(project_id, external_id) on sessions: when the same session was
 *     ingested under two project rows, the copy with more messages survives
 *     and the poorer duplicate is deleted (messages/chunks/embeddings cascade).
 *   - UNIQUE(source_id, external_id) on projects: the deleted row's
 *     external_id mapping is lost and logged — a future re-sync of that
 *     encoded dir will recreate a row (which this script can merge again).
 *
 * DRY-RUN by default — prints the merge plan. Pass --apply to execute:
 *   pnpm tsx scripts/merge-duplicate-projects.ts
 *   pnpm tsx scripts/merge-duplicate-projects.ts --apply
 */

import { query, transaction, closePool } from '../src/db/postgres.js'
import { decodeProjectPath, extractProjectName } from '../src/parsers/claude-messages.js'

const CATCH_ALL_NAMES = new Set(['projects'])

type ProjectRow = {
  id: number
  source_id: number
  source_name: string
  external_id: string
  path: string | null
  name: string | null
  session_count: number
}

type CanonicalProject = ProjectRow & {
  canonicalPath: string
  canonicalName: string
  fromCwd: boolean
}

const normalizeSeparators = (p: string) => p.replace(/\\/g, '/')

// A stored path is "encoded" when it never got decoded/corrected — no
// separators at all (e.g. "D--Projects-sporefall-art" or a bare dir name).
const looksEncoded = (p: string) => !p.includes('/') && !p.includes('\\')

const canonicalize = (project: ProjectRow, dominantCwd: string | null): CanonicalProject => {
  const fromCwd = dominantCwd != null && dominantCwd.length > 0
  const raw = fromCwd ? dominantCwd! : (project.path ?? project.external_id)
  const decoded = fromCwd || !looksEncoded(raw) ? raw : decodeProjectPath(raw)
  const canonicalPath = normalizeSeparators(decoded)
  return {
    ...project,
    canonicalPath,
    canonicalName: extractProjectName(canonicalPath),
    fromCwd,
  }
}

const isCatchAll = (p: CanonicalProject) =>
  CATCH_ALL_NAMES.has(p.canonicalName.toLowerCase()) ||
  CATCH_ALL_NAMES.has((p.name ?? '').toLowerCase())

const lastSegment = (path: string) => extractProjectName(path)

const run = async () => {
  const apply = process.argv.includes('--apply')
  console.log(`=== Merge duplicate projects (${apply ? 'APPLY' : 'DRY RUN'}) ===\n`)

  const projectsResult = await query<ProjectRow>(
    `SELECT p.id, p.source_id, src.name AS source_name, p.external_id, p.path, p.name,
            COUNT(s.id)::int AS session_count
     FROM projects p
     JOIN sources src ON p.source_id = src.id
     LEFT JOIN sessions s ON s.project_id = p.id
     GROUP BY p.id, src.name
     ORDER BY p.id`
  )

  // Dominant (most common) session cwd per project — the ground truth for the
  // project's real path, immune to hyphen-lossy decoding.
  const cwdResult = await query<{ project_id: number; cwd: string }>(
    `SELECT DISTINCT ON (project_id) project_id, cwd
     FROM (
       SELECT project_id, cwd, COUNT(*) AS uses
       FROM sessions
       WHERE cwd IS NOT NULL AND cwd <> ''
       GROUP BY project_id, cwd
     ) t
     ORDER BY project_id, uses DESC, cwd`
  )
  const dominantCwd = new Map(cwdResult.rows.map((r) => [r.project_id, r.cwd]))

  const projects = projectsResult.rows.map((p) => canonicalize(p, dominantCwd.get(p.id) ?? null))

  // --- Pass 1: group by source + canonical name + last path segment ---------
  const groups = new Map<string, CanonicalProject[]>()
  const groupKey = (p: CanonicalProject) =>
    `${p.source_id}|${p.canonicalName.toLowerCase()}|${lastSegment(p.canonicalPath).toLowerCase()}`

  for (const p of projects) {
    if (isCatchAll(p)) continue // never merge into/out of the Projects catch-all
    const key = groupKey(p)
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }

  // --- Pass 2: fold lossy-decoded singletons into existing groups ----------
  // A project whose stored path was still encoded and that has no session cwd
  // decodes lossily ("D--Projects-sporefall-art" → name "art"). Its encoded
  // dir name still carries the truth: it ends with "-sporefall-art". Fold it
  // into a group only when exactly ONE candidate name matches (ambiguity → skip).
  const groupList = () => Array.from(groups.values())
  for (const p of projects) {
    if (isCatchAll(p)) continue
    if (p.fromCwd) continue
    if (!looksEncoded(p.path ?? p.external_id)) continue
    const key = groupKey(p)
    if ((groups.get(key)?.length ?? 0) > 1) continue // already merging via pass 1

    const encodedLower = p.external_id.toLowerCase()
    const candidates = new Map<string, CanonicalProject[]>()
    for (const list of groupList()) {
      for (const other of list) {
        if (other.id === p.id || other.source_id !== p.source_id) continue
        const name = other.canonicalName.toLowerCase()
        if (name === p.canonicalName.toLowerCase()) continue // same as pass 1
        if (CATCH_ALL_NAMES.has(name)) continue
        if (encodedLower.endsWith(`-${name}`)) {
          const bucket = candidates.get(name) ?? []
          bucket.push(other)
          candidates.set(name, bucket)
        }
      }
    }
    if (candidates.size === 1) {
      const [[, targets]] = Array.from(candidates.entries())
      const target = targets[0]
      groups.get(key)?.splice(groups.get(key)!.indexOf(p), 1)
      groups.get(groupKey(target))!.push(p)
      console.log(
        `Pass 2: folding #${p.id} (${p.external_id}) into '${target.canonicalName}' via encoded-name suffix`
      )
    } else if (candidates.size > 1) {
      console.log(
        `Pass 2: skipping #${p.id} (${p.external_id}) — ambiguous suffix match: ${Array.from(candidates.keys()).join(', ')}`
      )
    }
  }

  const mergeGroups = Array.from(groups.values()).filter((list) => list.length > 1)
  if (mergeGroups.length === 0) {
    console.log('No duplicate projects found. Nothing to do.')
    return
  }

  console.log(`\nFound ${mergeGroups.length} duplicate group(s):\n`)

  let totalSessionsMoved = 0
  let totalDuplicateSessions = 0
  let totalProjectsDeleted = 0

  for (const group of mergeGroups) {
    group.sort((a, b) => a.id - b.id)
    const survivor = group[0]
    const losers = group.slice(1)

    // Best path/name for the survivor: prefer a cwd-derived canonical path
    // (survivor's own first, then the member with the most sessions).
    const bestSource =
      [survivor, ...losers].filter((p) => p.fromCwd).sort((a, b) => b.session_count - a.session_count)[0] ??
      survivor
    const bestPath = bestSource.canonicalPath
    const bestName = bestSource.canonicalName

    console.log(`Group '${bestName}' (source: ${survivor.source_name})`)
    console.log(
      `  KEEP   #${survivor.id}  external_id=${survivor.external_id}  path=${survivor.path}  sessions=${survivor.session_count}`
    )
    for (const loser of losers) {
      console.log(
        `  MERGE  #${loser.id}  external_id=${loser.external_id}  path=${loser.path}  sessions=${loser.session_count}`
      )
      console.log(
        `         (external_id mapping '${loser.external_id}' will be dropped — a future re-sync of that dir recreates a row)`
      )
    }
    console.log(`  → survivor path/name will be: ${bestPath} / ${bestName}`)

    // Session external_id collisions (same transcript ingested under both rows)
    const loserIds = losers.map((l) => l.id)
    const collisions = await query<{
      keep_id: number
      keep_count: number
      dup_id: number
      dup_count: number
      external_id: string
    }>(
      `SELECT sv.id AS keep_id, sv.message_count AS keep_count,
              ls.id AS dup_id, ls.message_count AS dup_count,
              ls.external_id
       FROM sessions ls
       JOIN sessions sv ON sv.external_id = ls.external_id AND sv.project_id = $1
       WHERE ls.project_id = ANY($2::int[])`,
      [survivor.id, loserIds]
    )

    // For each collision keep the copy with more messages; delete the other.
    const sessionsToDelete: number[] = []
    for (const c of collisions.rows) {
      const deleteId = c.dup_count > c.keep_count ? c.keep_id : c.dup_id
      const keepId = deleteId === c.dup_id ? c.keep_id : c.dup_id
      sessionsToDelete.push(deleteId)
      console.log(
        `  DUPLICATE session external_id=${c.external_id}: keeping #${keepId}, deleting #${deleteId} (messages cascade)`
      )
    }
    totalDuplicateSessions += sessionsToDelete.length

    const sessionsToMove = losers.reduce((sum, l) => sum + l.session_count, 0) - sessionsToDelete.length
    console.log(`  Sessions to re-point: ${sessionsToMove}`)
    totalSessionsMoved += sessionsToMove
    totalProjectsDeleted += losers.length

    if (apply) {
      await transaction(async (client) => {
        if (sessionsToDelete.length > 0) {
          await client.query(
            `UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ANY($1::int[])`,
            [sessionsToDelete]
          )
          await client.query(`DELETE FROM sessions WHERE id = ANY($1::int[])`, [sessionsToDelete])
        }
        await client.query(
          `UPDATE sessions SET project_id = $1 WHERE project_id = ANY($2::int[])`,
          [survivor.id, loserIds]
        )
        await client.query(
          `UPDATE history_entries SET project_id = $1 WHERE project_id = ANY($2::int[])`,
          [survivor.id, loserIds]
        )
        await client.query(`DELETE FROM projects WHERE id = ANY($1::int[])`, [loserIds])
        await client.query(`UPDATE projects SET path = $1, name = $2 WHERE id = $3`, [
          bestPath,
          bestName,
          survivor.id,
        ])
      })
      console.log(`  APPLIED.`)
    }
    console.log('')
  }

  console.log(`=== Summary (${apply ? 'applied' : 'dry run'}) ===`)
  console.log(`Duplicate groups:        ${mergeGroups.length}`)
  console.log(`Projects to delete:      ${totalProjectsDeleted}`)
  console.log(`Sessions to re-point:    ${totalSessionsMoved}`)
  console.log(`Duplicate sessions:      ${totalDuplicateSessions} (poorer copy deleted)`)
  if (!apply) console.log(`\nRe-run with --apply to execute.`)
  if (apply)
    console.log(
      `\nNOTE: project centroids are now stale — re-run \`pnpm run compute:centroids\`\n` +
        `(and expect orphaned project vectors in Chroma until the next centroid pass).`
    )
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => closePool())
