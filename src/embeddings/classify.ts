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

export const classifyNoise = (text: string): string | null => {
  // Judged on the real content, not the markup around it. The parser strips
  // scaffolding on the way in, but ~800 messages were stored before it did and
  // those rows still hold raw wrappers until the backfill runs. Length was the
  // exact hole they slipped through: 70 characters of `<command-name>` XML
  // clears the floor that the 3-character command inside it never would
  // (issue #37).
  const real = stripScaffolding(text)
  if (isScaffoldingOnly(text)) return 'scaffolding-only'
  if (real.length < 50) return `too-short:${real.length}`
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
