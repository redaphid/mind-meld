// Snippet = the one-line lead of a matched region, used as the triage surface
// in search results. ts_headline (computed in SQL) picks the query-relevant
// window when query terms exist; semantic-only hits fall back to the first
// sentence. Either way the result is collapsed to a single ~140-char line.
//
// Same source-of-truth as issue #4's excerpt — the snippet is its 1-line form.

export const SNIPPET_MAX_CHARS = 140

export const ts_headline_options =
  'StartSel=,StopSel=,MaxWords=25,MinWords=10,MaxFragments=1'

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

const cap = (text: string): string =>
  text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd()}…`

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
