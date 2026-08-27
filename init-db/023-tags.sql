-- Agent-managed tags, with an OPEN VOCABULARY.
--
-- Agents invent tags freely. There is no registration step and no table of
-- permitted tags, deliberately: other agents use mindmeld outside this
-- codebase's scope, and anything requiring pre-registration would break them
-- the first time one of them invented a word we had not thought of. Contrast
-- `data_class`, which IS a closed vocabulary validated by
-- assertKnownDataClasses() in src/mcp/search.ts -- that is exactly the pattern
-- this table must not grow. If you are here to add a CHECK constraint listing
-- allowed tags, that is the thing this design rules out.
--
-- The only thing enforced is normalization (trim + lowercase, applied in
-- src/mcp/tags.ts before the write): "Useless", "useless " and "useless" are
-- one tag rather than three. Normalizing is not validating -- nothing is
-- rejected for being unrecognised, it is only spelled consistently so that
-- filtering and the default-excluded set can match at all.

CREATE TABLE IF NOT EXISTS tags (
    id BIGSERIAL PRIMARY KEY,

    -- The tag itself. Always stored normalized. TEXT, not an enum and not a
    -- foreign key to a vocabulary table -- see the header.
    tag TEXT NOT NULL,

    -- EXACTLY ONE of these is set. A tag targets either a whole session or a
    -- single message; which granularity to use is the tagging agent's choice
    -- and the schema refuses to pick one for them. The CHECK below is what
    -- makes "exactly one" a fact rather than a convention, so a caller cannot
    -- create a row that is ambiguously both or neither.
    --
    -- ON DELETE CASCADE on both: a tag describes its target, so it has no
    -- meaning once the target is gone. Note this is a HARD delete only --
    -- sessions are normally soft-deleted (deleted_at), which leaves tags
    -- intact, which is what task 326 needs in order to make "useless"
    -- reversible.
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,

    -- Who applied it and why. Free text and nullable: useful provenance when
    -- an agent wants to explain a judgement call, never required, and never
    -- interpreted by anything.
    created_by TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT tags_exactly_one_target
        CHECK ((session_id IS NULL) <> (message_id IS NULL))
);

-- Tagging the same target twice with the same tag is a no-op, not a duplicate
-- row. Partial indexes rather than one UNIQUE(session_id, message_id, tag),
-- because NULL is never equal to NULL in a unique index: with a plain
-- three-column constraint, (NULL, 42, 'useless') could be inserted any number
-- of times and nothing would collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_session_tag
    ON tags (session_id, tag) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_message_tag
    ON tags (message_id, tag) WHERE message_id IS NOT NULL;

-- The filtering path looks up "every target carrying tag X", so tag leads.
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags (tag);
