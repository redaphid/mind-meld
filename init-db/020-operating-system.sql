-- Migration 020: record which operating system a project and session came
-- from (issue #33: "Have the mcp send to the api automatically the operating
-- system there thread/message came from").
--
-- `machine` (016) is a hostname — it says WHICH computer, never WHAT it runs,
-- and a hostname is opaque to code. The OS is the missing half, and it is not
-- bookkeeping: it is the fact that decides whether a path comparison may fold
-- case. `/mnt/d/Data` and `/mnt/d/data` are one directory under WSL and two
-- directories on any other Linux host, and 019's merge logic had to infer the
-- difference from observed `D:` paths because nothing recorded it. From here
-- on it is recorded.
--
-- Values are `process.platform` (`win32`, `linux`, `darwin`, …) with one
-- addition: `wsl`, because WSL reports itself as `linux` while its
-- `/mnt/<letter>` mounts are Windows drives. That distinction is precisely
-- the one that matters, so it gets its own value rather than being lost.
-- NULL means "not reported" — never a guess. Nothing is backfilled: rows
-- that predate this column stamp themselves on their next sync.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS os TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS os TEXT;

COMMENT ON COLUMN projects.os IS
  'Operating system of the host that last synced this project: win32 | wsl | linux | darwin | … NULL means not reported.';
COMMENT ON COLUMN sessions.os IS
  'Operating system the session was recorded on. NULL means not reported.';

-- Rows whose path is a Windows drive can only have come from Windows, and
-- that is a fact rather than a guess, so it is safe to seed. Everything else
-- is left NULL: `/mnt/d` could be WSL or an ordinary Linux mount, and
-- inventing an answer here is the exact mistake this column exists to stop.
UPDATE projects SET os = 'win32'
WHERE os IS NULL AND path ~ '^[A-Za-z]:(/|$)';
