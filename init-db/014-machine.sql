-- Migration: Record which computer indexed each project
-- Multiple machines sync into this one database, but nothing recorded which.
-- Path shape is not enough: the WSL distro and the laptop both use
-- /home/hypnodroid, so they are indistinguishable after the fact. Going forward
-- each sync process stamps its own MACHINE_NAME; this column is where it lands.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'machine'
  ) THEN
    ALTER TABLE projects ADD COLUMN machine VARCHAR(64);
    CREATE INDEX idx_projects_machine ON projects(machine);

    -- Backfill only what is unambiguous. A drive letter (or the D-- external_id
    -- form Claude Code derives from one) can only be the Windows box, and the
    -- android source is the phone.
    UPDATE projects SET machine = 'windows'
    WHERE machine IS NULL
      AND (path ~ '^[A-Za-z]:' OR external_id LIKE 'D--%');

    UPDATE projects SET machine = 'phone'
    WHERE machine IS NULL
      AND source_id IN (SELECT id FROM sources WHERE name = 'android');

    -- Deliberately NOT backfilled: /home/% projects. Both 'survivor' (the WSL
    -- distro) and 'soul' (the laptop) use that prefix, so any guess would be
    -- wrong for one of them and would look authoritative. They stay NULL and
    -- report as 'unknown' until their next sync stamps them correctly.
  END IF;
END $$;
