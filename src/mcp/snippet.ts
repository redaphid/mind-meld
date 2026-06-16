// Snippet = the one-line lead of a matched region, used as the triage surface
// in search results. ts_headline (computed in SQL) picks the query-relevant
// window when query terms exist; semantic-only hits fall back to the first
// sentence. Either way the result is collapsed to a single ~140-char line.
//
// Same source-of-truth as issue #4's excerpt — the snippet is its 1-line form.

export const SNIPPET_MAX_CHARS = 140

export const EXCERPT_MAX_CHARS = 300

export const ts_headline_options =
  'StartSel=,StopSel=,MaxWords=25,MinWords=10,MaxFragments=1'

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

const capTo = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

const cap = (text: string): string => capTo(text, SNIPPET_MAX_CHARS)

const firstSentence = (text: string): string => {
  const collapsed = collapse(text)
  const match = collapsed.match(/^.*?[.!?](?=\s|$)/)
  return match ? match[0] : collapsed
}

// headline: ts_headline output (query-highlighted window) when query terms ran.
// raw: the matched-tier source text (message content / chunk or session summary).
// Prefer the headline; fall back to the first sentence of raw for semantic-only.
export const buildSnippet = (raw: string | null, headline?: string | null): string | null => {
  const head = headline && collapse(headline).length > 0 ? collapse(headline) : null
  if (head) return cap(head)
  if (!raw || collapse(raw).length === 0) return null
  return cap(firstSentence(raw))
}

// Issue #4: a triage-blind result when a summary is NULL. The excerpt is the
// snippet's longer sibling — the same matched-region text, capped at ~300 chars
// instead of ~140 — shown (labeled) so a missing summary never reads as blank.
export const buildExcerpt = (raw: string | null, headline?: string | null): string | null => {
  const head = headline && collapse(headline).length > 0 ? collapse(headline) : null
  const text = head ?? (raw && collapse(raw).length > 0 ? collapse(raw) : null)
  return text ? capTo(text, EXCERPT_MAX_CHARS) : null
}
