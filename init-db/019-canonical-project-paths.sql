-- Migration 019: one canonical form for projects.path (issues #33, #22)
--
-- Three formats coexisted in projects.path — raw encoded directory names
-- (`D--mechs-comfy`), lossy decodes (`/home/u/Projects/clasp/laser/cube`,
-- `D:/mechs/win/setup`), and cwd-corrected Windows paths (`D:\mechs\chat`) —
-- because which one a row got depended on whether a session happened to carry
-- a cwd. This migration re-derives every path from the only lossless source:
--
--   * A session cwd is TRUSTED when re-encoding it (every non-alphanumeric
--     character becomes '-', exactly Claude Code's directory naming)
--     reproduces the project's external_id. Windows paths also match
--     case-insensitively, because that filesystem does.
--   * A verified path is stored canonically: forward slashes, uppercase drive
--     letter, no trailing separator (roots `/` and `D:/` keep theirs).
--   * A row no cwd ever verified reverts to its raw external_id — an honest
--     "unknown" instead of an invented decode. It heals automatically the
--     first time a sync sees a session with a verifying cwd.
--
-- Then duplicate rows describing the same real directory are merged. Two
-- paths are the same directory when their equivalence keys match: Windows
-- drive paths and their WSL drvfs twins (`D:/x` = `/mnt/d/x`) collapse
-- case-insensitively; unix paths compare exactly. MERGE (not keep-distinct)
-- is correct on the live data: every such pair carries machine='windows' on
-- both sides — one host, one directory, observed through two filesystems.
-- The merge stays merged because upsertProject (src/db/postgres.ts) adopts an
-- equivalent existing row instead of re-inserting a deleted external_id.
--
-- Defensive by construction: one DO block = one transaction; counts asserted
-- before/after; any surprise raises and rolls the whole thing back. The
-- session-level helpers live in pg_temp and vanish with the connection. They
-- MUST mirror src/utils/project-path.ts — that module is the one normalizer
-- for all runtime code; this file is its one-shot SQL twin for existing rows.

\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.mm_canon(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  p text;
  unc boolean;
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  p := btrim(input);
  IF p = '' THEN RETURN NULL; END IF;
  -- Not path-shaped (raw encoded names, pseudo-projects): pass through.
  IF position('/' in p) = 0 AND position('\' in p) = 0 AND p !~ '^[A-Za-z]:$' THEN
    RETURN p;
  END IF;
  p := replace(p, '\', '/');
  unc := p LIKE '//%';
  p := regexp_replace(p, '/{2,}', '/', 'g');
  IF unc THEN p := '/' || p; END IF;
  IF p ~ '^[a-z]:(/|$)' THEN p := upper(left(p, 1)) || substring(p from 2); END IF;
  IF p ~ '^[A-Za-z]:$' THEN p := p || '/'; END IF;
  WHILE length(p) > 1 AND right(p, 1) = '/' AND p !~ '^[A-Za-z]:/$' LOOP
    p := left(p, length(p) - 1);
  END LOOP;
  RETURN p;
END $fn$;

-- Claude Code's project-directory encoding: cwd with every non-alphanumeric
-- character replaced by '-'. Used to VERIFY a path against an external_id,
-- never to decode one.
CREATE FUNCTION pg_temp.mm_encode(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(p, '[^A-Za-z0-9]', '-', 'g')
$fn$;

-- Display name: last path segment ('D:/' names itself 'D:').
CREATE FUNCTION pg_temp.mm_name(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(
    NULLIF(regexp_replace(rtrim(p, '/'), '^.*/', ''), ''),
    NULLIF(rtrim(p, '/'), ''),
    p
  )
$fn$;

-- Same-directory key. NULL for anything that is not a real path: raw names
-- prove nothing about identity and must never merge on guesswork.
CREATE FUNCTION pg_temp.mm_equiv_key(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  c text;
BEGIN
  c := pg_temp.mm_canon(input);
  IF c IS NULL OR position('/' in c) = 0 THEN RETURN NULL; END IF;
  IF c ~ '^/mnt/[A-Za-z](/|$)' THEN
    RETURN lower(substring(c from 6 for 1) || ':' || COALESCE(NULLIF(substring(c from 7), ''), '/'));
  END IF;
  IF c ~ '^[A-Za-z]:(/|$)' THEN
    RETURN lower(c);
  END IF;
  RETURN c;
END $fn$;

DO $mig$
DECLARE
  claude_source_id integer;
  projects_before bigint;
  sessions_before bigint;
  messages_before bigint;
  projects_after bigint;
  sessions_after bigint;
  messages_after bigint;
  repathed integer := 0;
  reverted integer := 0;
  canonicalized integer := 0;
  merged_groups integer := 0;
  husks_deleted integer := 0;
  sessions_repointed integer := 0;
  history_repointed integer := 0;
  quarantine_repointed integer := 0;
  g record;
  survivor_id integer;
  husk_ids integer[];
  n integer;
BEGIN
  SELECT count(*) INTO projects_before FROM projects;
  SELECT count(*) INTO sessions_before FROM sessions;
  SELECT count(*) INTO messages_before FROM messages;

  SELECT id INTO claude_source_id FROM sources WHERE name = 'claude_code';

  IF claude_source_id IS NOT NULL THEN
    -- What each claude_code project's path SHOULD be, from best to worst
    -- evidence: a verifying session cwd (most frequent first, exact-case
    -- match preferred over case-insensitive), else an existing path that
    -- itself verifies and is provably not the old lossy decode, else the raw
    -- external_id.
    CREATE TEMP TABLE mm_decisions ON COMMIT DROP AS
    WITH cwd_counts AS (
      SELECT s.project_id, pg_temp.mm_canon(s.cwd) AS c, count(*) AS uses, max(s.started_at) AS latest
      FROM sessions s
      WHERE s.cwd IS NOT NULL
      GROUP BY 1, 2
    ),
    verified AS (
      SELECT DISTINCT ON (cc.project_id) cc.project_id, cc.c
      FROM cwd_counts cc
      JOIN projects p ON p.id = cc.project_id AND p.source_id = claude_source_id
      WHERE cc.c IS NOT NULL
        AND (pg_temp.mm_encode(cc.c) = p.external_id
             OR lower(pg_temp.mm_encode(cc.c)) = lower(p.external_id))
      ORDER BY cc.project_id,
               (pg_temp.mm_encode(cc.c) = p.external_id) DESC,
               cc.uses DESC,
               cc.latest DESC NULLS LAST,
               cc.c
    )
    SELECT p.id AS project_id,
           COALESCE(
             v.c,
             CASE
               WHEN p.path IS NOT NULL
                    AND p.path <> p.external_id
                    -- The old lossy decode of a `-...` name is exactly the
                    -- external_id with every '-' turned into '/': that shape
                    -- is a guess, never evidence.
                    AND NOT (p.external_id LIKE '-%' AND p.path = replace(p.external_id, '-', '/'))
                    AND (pg_temp.mm_encode(pg_temp.mm_canon(p.path)) = p.external_id
                         OR lower(pg_temp.mm_encode(pg_temp.mm_canon(p.path))) = lower(p.external_id))
               THEN pg_temp.mm_canon(p.path)
             END,
             p.external_id
           ) AS new_path
    FROM projects p
    LEFT JOIN verified v ON v.project_id = p.id
    WHERE p.source_id = claude_source_id;

    -- Verified rows: canonical path, name re-derived from it.
    UPDATE projects p
    SET path = d.new_path,
        name = pg_temp.mm_name(d.new_path)
    FROM mm_decisions d
    WHERE p.id = d.project_id
      AND d.new_path <> p.external_id
      AND (p.path IS DISTINCT FROM d.new_path OR p.name IS DISTINCT FROM pg_temp.mm_name(d.new_path));
    GET DIAGNOSTICS repathed = ROW_COUNT;

    -- Unverifiable rows: back to the raw name. The old name (a last-segment
    -- guess) is kept — it is display-only and harmless.
    UPDATE projects p
    SET path = d.new_path
    FROM mm_decisions d
    WHERE p.id = d.project_id
      AND d.new_path = p.external_id
      AND p.path IS DISTINCT FROM d.new_path;
    GET DIAGNOSTICS reverted = ROW_COUNT;
  END IF;

  -- Every remaining row of every source: canonical separators, '' becomes
  -- NULL. Idempotent by construction.
  UPDATE projects p
  SET path = pg_temp.mm_canon(p.path)
  WHERE p.path IS DISTINCT FROM pg_temp.mm_canon(p.path);
  GET DIAGNOSTICS canonicalized = ROW_COUNT;

  -- Merge rows that are now provably the same directory. Survivor: most
  -- sessions, then oldest row, then lowest id.
  FOR g IN
    SELECT p.source_id, pg_temp.mm_equiv_key(p.path) AS k, array_agg(p.id ORDER BY p.id) AS ids
    FROM projects p
    WHERE pg_temp.mm_equiv_key(p.path) IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) > 1
  LOOP
    SELECT p.id INTO survivor_id
    FROM projects p
    LEFT JOIN LATERAL (SELECT count(*) AS sessions FROM sessions s WHERE s.project_id = p.id) sc ON true
    WHERE p.id = ANY(g.ids)
    ORDER BY sc.sessions DESC, p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;

    husk_ids := array_remove(g.ids, survivor_id);

    -- A session external_id may exist only once in the merged project. A
    -- collision would mean these rows are NOT the same project — refuse and
    -- roll everything back rather than guess.
    IF EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.project_id = ANY(g.ids)
      GROUP BY s.external_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'migration 019: session external_id collision while merging projects % (key %)', g.ids, g.k;
    END IF;

    UPDATE sessions SET project_id = survivor_id WHERE project_id = ANY(husk_ids);
    GET DIAGNOSTICS n = ROW_COUNT;
    sessions_repointed := sessions_repointed + n;

    UPDATE history_entries SET project_id = survivor_id WHERE project_id = ANY(husk_ids);
    GET DIAGNOSTICS n = ROW_COUNT;
    history_repointed := history_repointed + n;

    UPDATE sync_quarantine SET project_id = survivor_id WHERE project_id = ANY(husk_ids);
    GET DIAGNOSTICS n = ROW_COUNT;
    quarantine_repointed := quarantine_repointed + n;

    -- Absorb what the survivor lacks; a merged project's centroid is stale by
    -- definition, so clear it for the periodic recompute.
    UPDATE projects s
    SET machine = COALESCE(s.machine,
          (SELECT machine FROM projects WHERE id = ANY(husk_ids) AND machine IS NOT NULL LIMIT 1)),
        last_synced_at = GREATEST(s.last_synced_at,
          (SELECT max(last_synced_at) FROM projects WHERE id = ANY(husk_ids))),
        centroid_vector = NULL,
        centroid_message_count = NULL,
        centroid_computed_at = NULL
    WHERE s.id = survivor_id;

    DELETE FROM projects WHERE id = ANY(husk_ids);
    GET DIAGNOSTICS n = ROW_COUNT;
    husks_deleted := husks_deleted + n;
    merged_groups := merged_groups + 1;
  END LOOP;

  -- Nothing may be lost, only moved.
  SELECT count(*) INTO projects_after FROM projects;
  SELECT count(*) INTO sessions_after FROM sessions;
  SELECT count(*) INTO messages_after FROM messages;

  IF sessions_after <> sessions_before THEN
    RAISE EXCEPTION 'migration 019: session count changed (% -> %)', sessions_before, sessions_after;
  END IF;
  IF messages_after <> messages_before THEN
    RAISE EXCEPTION 'migration 019: message count changed (% -> %)', messages_before, messages_after;
  END IF;
  IF projects_after <> projects_before - husks_deleted THEN
    RAISE EXCEPTION 'migration 019: project count % does not equal % minus % merged husks',
      projects_after, projects_before, husks_deleted;
  END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE position('\' in path) > 0) THEN
    RAISE EXCEPTION 'migration 019: a backslash path survived canonicalization';
  END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE position('//' in path) > 0 AND path NOT LIKE '//%') THEN
    RAISE EXCEPTION 'migration 019: a double-slash (lossy-decode) path survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM projects p
    WHERE pg_temp.mm_equiv_key(p.path) IS NOT NULL
    GROUP BY p.source_id, pg_temp.mm_equiv_key(p.path)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration 019: duplicate equivalent projects remain after merge';
  END IF;

  RAISE NOTICE 'migration 019: % re-pathed from verified cwds, % reverted to raw names, % canonicalized in place, % duplicate groups merged (% husks deleted, % sessions / % history / % quarantine rows repointed)',
    repathed, reverted, canonicalized, merged_groups, husks_deleted,
    sessions_repointed, history_repointed, quarantine_repointed;
END $mig$;
