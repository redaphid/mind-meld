// Session title resolution (issue #95).
//
// `sessions.title` used to be `firstMessage.slice(0, 200)` for every Claude Code
// session — a real message cut mid-word and presented as a topic. 72% of
// claude_code sessions carried one, 152 of them still did *after* being
// summarized, because the column is written exactly once at sync and never
// re-derived. A triaging LLM got an instruction blob where a topic belonged.
//
// Titles are now resolved at read time and never fabricated:
//
//   1. the stored title, when the source actually supplied one (Android threads
//      do; Claude Code has no title field, so it now stores NULL)
//   2. the opening sentence of the summary, once one exists
//   3. nothing — an honest blank beats a misleading sentence
//
// `titleSource` travels with the title so a consumer can tell a real title from
// a derived one, rather than having to guess as it does today.

export type TitleSource = 'source' | 'summary' | 'none'

export type ResolvedTitle = {
  title: string | null
  titleSource: TitleSource
}

const NO_TITLE: ResolvedTitle = { title: null, titleSource: 'none' }

// A sentence ends at .!? followed by whitespace and a capital/quote/bracket.
// Requiring the follower keeps "v1.13.0", "e.g.", and "No. 4" intact — the point
// is that a derived title always ends on a real boundary, never mid-word.
const SENTENCE_END = /([.!?])\s+(?=["'([]?[A-Z0-9])/

const firstMeaningfulLine = (text: string): string | null => {
  for (const raw of text.split('\n')) {
    // Strip markdown heading markers and list bullets so a summary that opens
    // with "## Summary" titles as "Summary" rather than as its own formatting.
    const line = raw.replace(/^\s*(?:#{1,6}|[-*+])\s+/, '').trim()
    if (line.length > 0) return line
  }
  return null
}

const openingSentence = (line: string): string => {
  const match = SENTENCE_END.exec(line)
  if (!match || match.index === undefined) return line
  return line.slice(0, match.index + match[1].length)
}

/**
 * Resolve the title to display for a session. Never invents one: when there is
 * neither a source-supplied title nor a summary, the answer is `null` and
 * `titleSource: 'none'`, and the caller shows the project, date and snippet
 * instead of a fabricated topic.
 */
export const resolveTitle = (row: { title: string | null; summary: string | null }): ResolvedTitle => {
  const stored = row.title?.trim()
  if (stored) return { title: stored, titleSource: 'source' }

  const summary = row.summary?.trim()
  if (!summary) return NO_TITLE

  const line = firstMeaningfulLine(summary)
  if (!line) return NO_TITLE

  return { title: openingSentence(line), titleSource: 'summary' }
}

/**
 * The "not a warmup session" SQL predicate, NULL-safe.
 *
 * Warmup sessions are marked by setting their title to the literal 'Warmup'
 * (scripts/mark-warmups.ts) and are excluded from summarization, centroids and
 * the health counts. The exclusions were written as `title != 'Warmup'`, which
 * was fine while every session had a title. Now that an unsummarized Claude
 * Code session has none, `NULL != 'Warmup'` evaluates to NULL rather than true
 * and the row is dropped — which would have quietly removed every untitled
 * session from the summarization batch, i.e. exactly the sessions that need a
 * summary in order to get a title at all.
 */
export const notWarmup = (alias?: string): string =>
  `${alias ? `${alias}.` : ''}title IS DISTINCT FROM 'Warmup'`
