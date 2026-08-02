// Formatting helpers shared by every view. No dependencies beyond preact's html.

import { html } from 'preact'

export const fmtNum = n => {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  return v.toLocaleString()
}

export const fmtExact = n => Number(n ?? 0).toLocaleString()

const UNITS = [
  [31536000, 'y'],
  [2592000, 'mo'],
  [604800, 'w'],
  [86400, 'd'],
  [3600, 'h'],
  [60, 'm'],
]

// "3h ago" / "in 2m". Returns null for a missing date so callers can omit the
// element entirely rather than printing a placeholder.
export const timeAgo = iso => {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const diff = (Date.now() - then) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  for (const [secs, label] of UNITS) {
    if (abs >= secs) {
      const n = Math.floor(abs / secs)
      return diff >= 0 ? `${n}${label} ago` : `in ${n}${label}`
    }
  }
  return 'just now'
}

export const fmtDate = iso => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export const fmtDateTime = iso => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Search snippets carry ts_headline's markdown bold around the matched terms
// (see src/mcp/snippet.ts). Split on it rather than injecting HTML, so nothing
// from a conversation can ever be interpreted as markup.
export const highlight = text => {
  if (!text) return null
  return text.split(/\*\*/).map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : part))
}

export const sourceLabel = source =>
  ({ claude_code: 'Claude Code', cursor: 'Cursor', huddle: 'Huddle', android: 'Android' })[source] ??
  source

// A project path is long and the interesting end is the last segments.
export const shortPath = path => {
  if (!path) return ''
  const parts = String(path).split(/[/\\]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

export const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
