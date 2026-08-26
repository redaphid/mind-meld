import { stripScaffolding, isScaffoldingOnly } from '../utils/strip-scaffolding.js'

// Patterns that indicate tool output, boilerplate, or noise — not worth embedding
export const NOISE_PATTERNS = [
  /^\[Request interrupted/,
  /^\[THINKING\]/,
  /^No results found/,
  /^No files found/,
  /^No matches found/,
  /^File created successfully/,
  /^Updated task #/,
  /^MCP (error|tool call)/,
  /^To github\.com/,
  /^Exit code \d/,
  /^\s*(CREATE TABLE|COPY \d|DROP TABLE|ALTER TABLE|INSERT \d)/,
  /^\s*\d+ rows? affected/,
  /^\{"ok":false/,
  /^📬\s*\*?\*?Slack heads-up/m,
  /^##\s*Slack Brief/m,
  /^All clear! No urgent items/m,
  /ACCESSIBILITY ACCOMMODATION.*screen reader/s,
  /IMMEDIATE DISMISSAL.*dismissed-urls\.txt/s,
]

// How short a message may be before it is written off as noise.
//
// The 50-character floor was measured against CODING transcripts, where nearly
// everything under it is tool chatter -- `Exit code 0`, `done`, `File created
// successfully`. That reasoning does not survive contact with a conversation.
// In a chat thread the short line IS the content: a question about where to
// meet, or an answer naming the place, is routinely under 50 characters and
// carries the whole fact. Applying the coding floor to conversational sources
// discarded the MAJORITY of every chat corpus indexed here -- measured at 54%
// and 39% of two of them -- behind permanent UNEMBEDDABLE markers, leaving the
// message tier of semantic search with nothing to match against.
//
// So the floor is per data class, not global. Conversational sources fall back
// to the same 10-character gate the SQL predicate in pending.ts already
// applies, just measured on the scaffolding-stripped text so a wrapper cannot
// pad a two-word message over the line.
const CODING_MIN_CHARS = 50
const CONVERSATIONAL_MIN_CHARS = 10

// Only `coding` earns the aggressive floor. Anything else -- personal, notes,
// meetings, and any class added later -- is presumed to be human conversation,
// which is the safer default: over-embedding costs GPU time, under-embedding
// loses the message permanently behind an UNEMBEDDABLE marker.
export const minContentChars = (dataClass?: string | null): number =>
  (dataClass ?? 'coding').trim().toLowerCase() === 'coding'
    ? CODING_MIN_CHARS
    : CONVERSATIONAL_MIN_CHARS

export const classifyNoise = (text: string, dataClass?: string | null): string | null => {
  // Judged on the real content, not the markup around it. The parser strips
  // scaffolding on the way in, but ~800 messages were stored before it did and
  // those rows still hold raw wrappers until the backfill runs. Length was the
  // exact hole they slipped through: 70 characters of `<command-name>` XML
  // clears the floor that the 3-character command inside it never would
  // (issue #37).
  const real = stripScaffolding(text)
  if (isScaffoldingOnly(text)) return 'scaffolding-only'
  if (real.length < minContentChars(dataClass)) return `too-short:${real.length}`
  const matched = NOISE_PATTERNS.find((p) => p.test(real))
  if (matched) return `pattern:${matched.source}`
  return null
}

// Persona prompts that mark a session as an automated, non-interactive run
// (Slack monitoring, curiosity curation, MCP health checks, huddle transcripts).
// These show up as the leading line of the session title / first user message.
const AUTOMATED_PATTERNS = [
  /^You are a Slack monitoring assistant/,
  /^You are a curiosity curator/,
  /^You are an ADHD accessibility assistant/,
  /^You are an MCP availability checker/,
  /^You are Henchman, the theatrical lab assistant/,
  /^Huddle in #/,
]

export const classifyAutomated = (title: string | null): string | null => {
  if (!title) return null
  const firstLine = title.split('\n')[0].trim()
  const matched = AUTOMATED_PATTERNS.find((p) => p.test(firstLine))
  if (matched) return `pattern:${matched.source}`
  return null
}

export const isAutomated = (title: string | null): boolean => classifyAutomated(title) !== null
