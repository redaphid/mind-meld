// Decides what to do with a message that was stored before the parser began
// stripping harness scaffolding (issue #37).
//
// Kept pure and separate from the script that performs the writes, so the
// decision — the part that can silently destroy content if it is wrong — is
// unit-testable without a database, and so a dry run and a real run provably
// make the same decisions.

import { stripScaffolding, isScaffoldingOnly, hasScaffolding } from '../utils/strip-scaffolding.js'

export interface BackfillRow {
  id: number
  session_id: number
  content_text: string
}

export type StripAction =
  // No scaffolding present, or removing it changed nothing. Do not touch.
  | 'skip'
  // Nothing but scaffolding. The row becomes an empty husk; embedding it
  // spends a vector on a string nobody will search for.
  | 'unembeddable'
  // Real content survives. Store the stripped text.
  | 'rewrite'

export interface StripPlan {
  id: number
  sessionId: number
  action: StripAction
  original: string
  stripped: string
  // Fraction of the original that was markup.
  removedFraction: number
  // Whether the stored vector has to go. Re-embedding is not free — the
  // embedding queue is the bottleneck for findability (issue #36) — so a
  // vector is only discarded when the text it was computed from was
  // materially different from the truth.
  dropVector: boolean
  reason: string
}

// A strip that removed less than this much of a message left the meaning, and
// therefore the embedding, essentially intact. Matches the threshold the
// earlier hook-injection pass used.
export const INVALIDATE_THRESHOLD = 0.1

export const planStrip = (row: BackfillRow): StripPlan => {
  const original = row.content_text ?? ''
  const base = {
    id: row.id,
    sessionId: row.session_id,
    original,
    removedFraction: 0,
    dropVector: false,
  }

  if (!hasScaffolding(original))
    return { ...base, action: 'skip', stripped: original, reason: 'no-scaffolding' }

  const stripped = stripScaffolding(original)
  if (stripped === original.trim())
    return { ...base, action: 'skip', stripped, reason: 'no-change' }

  const removedFraction = original.length === 0 ? 0 : 1 - stripped.length / original.length

  if (isScaffoldingOnly(original))
    return {
      ...base,
      action: 'unembeddable',
      stripped,
      removedFraction,
      dropVector: true,
      reason: 'scaffolding-only',
    }

  return {
    ...base,
    action: 'rewrite',
    stripped,
    removedFraction,
    dropVector: removedFraction >= INVALIDATE_THRESHOLD,
    reason: removedFraction >= INVALIDATE_THRESHOLD ? 'material-change' : 'minor-change',
  }
}
