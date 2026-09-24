-- Corpus-level vectors used to steer search AWAY from material judged useless.
--
-- The `useless` tag (023-tags.sql) already HIDES the sessions you labelled --
-- it is in config.defaultExcluded, so a plain search never returns them. What
-- it cannot do is generalize: a session that is indistinguishable from your 64
-- labelled ones, but which you never happened to label, ranks exactly as it did
-- before. This table stores the vectors that close that gap.
--
-- WHY TWO VECTORS AND NOT ONE
--
-- The obvious implementation is "average the embeddings of everything tagged
-- useless, then penalize results similar to that average". Measured against the
-- live corpus, that implementation does nothing useful, and it took a control
-- to see it:
--
--     || mean of 54 useless centroids ||  = 0.8421   <- looks like a tight cluster
--     || mean of 54 RANDOM centroids  ||  = 0.7579   <- ...so does random noise
--
-- bge-m3 embeddings are strongly anisotropic: every vector in the corpus sits
-- inside a narrow cone, so cosine similarity between two unrelated sessions is
-- already ~0.7. A similarity of 0.84 is therefore not evidence of anything. The
-- shared component -- `global_mean` below -- has to be subtracted before any
-- comparison means what it appears to mean. Once it is:
--
--     centered cohesion, useless  = 0.5136
--     centered cohesion, random   = 0.1649
--     centered cos(C_useless, d) for unlabelled sessions, mean = -0.0150
--
-- i.e. a threshold at the useless median catches half the labelled sessions and
-- 1 unlabelled session in 549. That is the signal this table exists to carry.
--
-- Keep `global_mean` as a stored row rather than recomputing it per query: it is
-- an average over every live session, it drifts slowly, and it must be the
-- SAME vector that was used when C_useless was built. Recomputing one without
-- the other silently changes the basis both are expressed in.

CREATE TABLE IF NOT EXISTS quality_vectors (
    -- 'global_mean' | 'useless'. A short open key rather than an enum, for the
    -- same reason tags are open: a later judgement direction ('low-value' is a
    -- candidate, though it measures as noise TODAY) should not need a migration.
    name TEXT PRIMARY KEY,

    -- JSON array of floats, matching the representation already used by
    -- sessions.centroid_vector (005-centroids.sql). Deliberately the same shape
    -- and the same lack of pgvector: these are read a handful of times per
    -- query, never indexed or searched, so a typed vector column would buy
    -- nothing and add an extension dependency.
    --
    -- Stored NORMALIZED to unit length. The magnitude that mattered is recorded
    -- separately as `cohesion` -- see below.
    vector TEXT NOT NULL,

    -- How many member vectors were averaged. Below ~20 the mean of a handful of
    -- high-dimensional vectors is dominated by whichever ones you happened to
    -- label, so search refuses to apply a penalty at all.
    member_count INTEGER NOT NULL,

    -- || mean of the centered member unit-vectors ||, BEFORE normalization.
    --
    -- This is the whole measurement, and it is worth stating plainly because
    -- the number is easy to store and hard to interpret: averaging unit vectors
    -- that point the same way gives a result of length ~1; averaging unit
    -- vectors that point in random directions gives a result of length ~0,
    -- because the components cancel. So the LENGTH of the average is a direct
    -- readout of how much the members agree -- and normalizing the vector (which
    -- we must, to use it) destroys exactly that information. Hence the column.
    cohesion REAL NOT NULL,

    -- The same quantity computed over an equal-size RANDOM sample. Without this
    -- control, `cohesion` is uninterpretable -- see the 0.8421-vs-0.7579 trap in
    -- the header. Search compares the two and skips the penalty when the
    -- labelled set is no tighter than chance, so a signal that decays as tags
    -- drift announces itself instead of quietly becoming a noise multiplier.
    baseline REAL NOT NULL,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE quality_vectors IS
    'Corpus-level direction vectors for quality-aware ranking. See header of init-db/024-quality-vectors.sql: cohesion is only meaningful relative to baseline.';
