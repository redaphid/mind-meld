-- Every search, and every call that follows one, as a row: the source for
-- usage stats, real-query benchmark ground truth, and implicit feedback.
-- Written by src/mcp/search-log.ts, never on a search's response path.
--
-- PERSONAL DATA: `request` holds the query text as sent. It is nulled after
-- MINDMELD_SEARCH_LOG_RAW_DAYS (default 180); `request_hash` stays so repeated
-- queries remain countable. No HTTP route returns raw rows.

CREATE TABLE IF NOT EXISTS search_log (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Links a search to the calls that follow it. "mcp:<transport session id>",
    -- "stdio:<pid>.<start>", or "rest:<X-Mindmeld-Caller header, else anon>".
    caller       TEXT NOT NULL,
    transport    TEXT NOT NULL CHECK (transport IN ('mcp-http', 'mcp-stdio', 'rest')),
    -- MCP clientInfo "name/version", or the X-Mindmeld-Client header over REST.
    client       TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('search', 'open', 'tag')),
    tool         TEXT NOT NULL,
    -- A search's own handle, or the list a follow-up was linked to.
    list         TEXT,
    request      JSONB,
    request_hash TEXT,
    -- Search rows.
    mode         TEXT,
    results      JSONB,           -- [{ s, rank, score, tier, damping, cursor? }], rank from 1
    result_count INTEGER,
    degraded     TEXT,            -- SearchDegradation.cause, null when healthy
    error        TEXT,            -- error class name when the search threw
    timings      JSONB,           -- { totalMs, semanticMs, embedMs, sessionMs, chunkMs, messageMs, fullTextMs }
    -- Follow-up rows.
    session_id   INTEGER,
    target       JSONB,           -- { sessionId?, messageId?, chunkIndex? } as asked
    rank         INTEGER,         -- position of session_id in the linked list
    signal       TEXT CHECK (signal IN ('open', 'tag', 'untag', 'useless', 'unuseless'))
);

CREATE INDEX IF NOT EXISTS search_log_caller_at_idx ON search_log (caller, at DESC);
CREATE INDEX IF NOT EXISTS search_log_list_idx ON search_log (list);
CREATE INDEX IF NOT EXISTS search_log_at_idx ON search_log (at);
