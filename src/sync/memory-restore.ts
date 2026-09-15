import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { query } from '../db/postgres.js';
import { hashContent } from '../parsers/claude-memory.js';
import { memoryExternalId } from './claude-memory.js';

// The read side of the memory backup (src/sync/claude-memory.ts writes it).
//
// This exists because a backup nobody has restored is a claim, not a backup.
// The interesting case is the one that motivated the whole feature: a memory
// file that no longer exists on disk. Its rows are still here, so `list` shows
// it and `restore` writes it back -- and neither needs the file to be present.
export interface MemoryVersionRow {
  sessionId: number;
  projectExternalId: string;
  projectPath: string | null;
  fileName: string;
  versionNum: number;
  contentHash: string;
  content: string;
  timestamp: Date;
  // Where sync last saw the file. Used as the default restore target, so a
  // restore puts the memory back where it came from rather than somewhere a
  // reader has to go find.
  rawFilePath: string | null;
}

// One row per memory: its LATEST stored version. `versionNum` is the count of
// distinct texts ever indexed, so a memory showing 3 has two superseded texts
// underneath it that only this table still holds.
export const listMemories = async (options?: {
  projectFilter?: string;
}): Promise<MemoryVersionRow[]> => {
  const params: string[] = [];
  let filter = '';
  if (options?.projectFilter) {
    params.push(`%${options.projectFilter}%`);
    filter = `AND (p.external_id ILIKE $1 OR COALESCE(p.path, '') ILIKE $1)`;
  }

  const result = await query<{
    session_id: number;
    project_external_id: string;
    project_path: string | null;
    external_id: string;
    version_num: number;
    content_text: string;
    timestamp: Date;
    raw_file_path: string | null;
  }>(
    `SELECT DISTINCT ON (s.id)
       s.id AS session_id,
       p.external_id AS project_external_id,
       p.path AS project_path,
       s.external_id,
       m.sequence_num AS version_num,
       m.content_text,
       m.timestamp,
       s.raw_file_path
     FROM sessions s
     JOIN projects p ON s.project_id = p.id
     JOIN messages m ON m.session_id = s.id
     WHERE s.external_id LIKE 'memory:%'
       AND m.role = 'memory'
       AND m.content_text IS NOT NULL
       ${filter}
     -- Latest version per memory. sequence_num first because it is the
     -- version order this index actually assigned; timestamp breaks ties for
     -- rows written before sequencing, and id is the final tiebreak so the
     -- choice is deterministic rather than whatever the planner returns.
     ORDER BY s.id, m.sequence_num DESC NULLS LAST, m.timestamp DESC, m.id DESC`,
    params
  );

  return result.rows.map((r) => ({
    sessionId: r.session_id,
    projectExternalId: r.project_external_id,
    projectPath: r.project_path,
    fileName: r.external_id.replace(/^memory:/, ''),
    versionNum: r.version_num ?? 1,
    contentHash: hashContent(r.content_text),
    content: r.content_text,
    timestamp: r.timestamp,
    rawFilePath: r.raw_file_path,
  }));
};

// Every stored version of one memory, oldest first. This is the history that
// exists nowhere else -- the file on disk only ever holds the newest text.
export const listVersions = async (params: {
  projectExternalId: string;
  fileName: string;
}): Promise<MemoryVersionRow[]> => {
  const result = await query<{
    session_id: number;
    project_external_id: string;
    project_path: string | null;
    version_num: number;
    content_text: string;
    timestamp: Date;
    raw_file_path: string | null;
  }>(
    `SELECT s.id AS session_id, p.external_id AS project_external_id, p.path AS project_path,
            m.sequence_num AS version_num, m.content_text, m.timestamp, s.raw_file_path
     FROM sessions s
     JOIN projects p ON s.project_id = p.id
     JOIN messages m ON m.session_id = s.id
     WHERE p.external_id = $1
       AND s.external_id = $2
       AND m.role = 'memory'
       AND m.content_text IS NOT NULL
     ORDER BY m.sequence_num ASC NULLS FIRST, m.timestamp ASC, m.id ASC`,
    [params.projectExternalId, memoryExternalId(params.fileName)]
  );

  return result.rows.map((r) => ({
    sessionId: r.session_id,
    projectExternalId: r.project_external_id,
    projectPath: r.project_path,
    fileName: params.fileName,
    versionNum: r.version_num ?? 1,
    contentHash: hashContent(r.content_text),
    content: r.content_text,
    timestamp: r.timestamp,
    rawFilePath: r.raw_file_path,
  }));
};

export interface RestoreOutcome {
  targetPath: string;
  // written  — the file did not exist, or existed with different text
  // identical — the file already holds exactly this text; nothing was done
  // skipped   — the file exists with DIFFERENT text and --force was not given
  status: 'written' | 'identical' | 'skipped';
  fileName: string;
}

// Where a memory goes when restored: under `<outDir>/<project slug>/`, or back
// to the exact path sync last read it from when no outDir is given.
export const restoreTarget = (row: MemoryVersionRow, outDir?: string): string => {
  if (outDir) return join(outDir, row.projectExternalId, `${row.fileName}.md`);
  if (row.rawFilePath) return row.rawFilePath;
  throw new Error(
    `No recorded path for memory ${row.projectExternalId}/${row.fileName} — pass an output directory`
  );
};

// Write one memory version to disk.
//
// Refuses by default to overwrite a file whose text differs from the stored
// version. Restoring in place is the dangerous direction of this feature: the
// on-disk file may be NEWER than anything indexed (edited since the last
// sync), and a blind restore would destroy exactly the kind of unbacked-up
// text this whole system exists to preserve. So a differing file is reported
// and left alone unless the caller insists.
export const restoreMemory = async (
  row: MemoryVersionRow,
  options?: { outDir?: string; force?: boolean }
): Promise<RestoreOutcome> => {
  const targetPath = restoreTarget(row, options?.outDir);

  let existing: string | null = null;
  try {
    existing = await readFile(targetPath, 'utf8');
  } catch {
    existing = null;
  }

  if (existing !== null) {
    if (hashContent(existing) === row.contentHash)
      return { targetPath, status: 'identical', fileName: row.fileName };
    if (!options?.force) return { targetPath, status: 'skipped', fileName: row.fileName };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, row.content, 'utf8');
  return { targetPath, status: 'written', fileName: row.fileName };
};
