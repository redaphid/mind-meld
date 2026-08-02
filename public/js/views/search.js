// Search — the reason the UI exists. Hybrid fuses the vector index (Chroma,
// over sessions/chunks/messages) with Postgres full-text; the toggle lets you
// run either arm alone when you want to see what each one actually found.

import { html, useState, useEffect, useRef } from 'preact'
import { useApi } from '../api.js'
import { useRoute, navigate } from '../router.js'
import { Spinner, ErrorBox, Empty, SessionRow, Pill } from '../ui.js'
import { sourceLabel } from '../util.js'

const MODES = [
  ['hybrid', 'Hybrid'],
  ['semantic', 'Vector'],
  ['text', 'Full-text'],
]

const SINCE = [
  ['', 'Any time'],
  ['24 hours ago', 'Last 24h'],
  ['7 days ago', 'Last week'],
  ['30 days ago', 'Last month'],
  ['6 months ago', 'Last 6 months'],
]

const SOURCES = [
  ['', 'All sources'],
  ['claude_code', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['huddle', 'Huddle'],
  ['android', 'Android'],
]

export const SearchView = () => {
  const { query } = useRoute()
  const [draft, setDraft] = useState(query.q ?? '')
  const [showOpts, setShowOpts] = useState(false)
  const inputRef = useRef(null)

  // The URL is the source of truth: back/forward and a shared link both restore
  // the exact search. The box only holds what hasn't been submitted yet.
  useEffect(() => setDraft(query.q ?? ''), [query.q])

  const submitted = query.q?.trim() ?? ''
  const params = {
    q: submitted,
    mode: query.mode ?? 'hybrid',
    limit: query.limit ?? 20,
    source: query.source ?? '',
    since: query.since ?? '',
    includeAutomated: query.includeAutomated === '1' ? '1' : '',
  }

  const { data, error, loading, reload } = useApi(submitted ? '/api/search' : null, params, params)

  const run = (patch = {}) =>
    navigate('search', {
      ...query,
      q: draft.trim(),
      ...patch,
    })

  const setOpt = (key, value) => navigate('search', { ...query, q: submitted, [key]: value })

  return html`
    <form
      class="search-bar"
      onSubmit=${e => {
        e.preventDefault()
        inputRef.current?.blur()
        run()
      }}
    >
      <input
        ref=${inputRef}
        type="search"
        name="q"
        placeholder="Search every conversation…"
        value=${draft}
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        enterkeyhint="search"
        onInput=${e => setDraft(e.target.value)}
      />
      <button class="btn primary" type="submit" disabled=${!draft.trim()}>Go</button>
    </form>

    <div class="seg">
      ${MODES.map(
        ([value, label]) => html`
          <button
            type="button"
            class=${params.mode === value ? 'on' : ''}
            onClick=${() => setOpt('mode', value)}
          >
            ${label}
          </button>
        `
      )}
    </div>

    <div class="filters">
      <select value=${params.since} onChange=${e => setOpt('since', e.target.value)}>
        ${SINCE.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
      </select>
      <select value=${params.source} onChange=${e => setOpt('source', e.target.value)}>
        ${SOURCES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
      </select>
      <button class="btn sm" type="button" onClick=${() => setShowOpts(s => !s)}>
        ${showOpts ? 'Less' : 'More'}
      </button>
    </div>

    ${showOpts &&
    html`
      <div class="filters">
        <select value=${String(params.limit)} onChange=${e => setOpt('limit', e.target.value)}>
          ${[10, 20, 50, 100].map(n => html`<option value=${String(n)}>${n} results</option>`)}
        </select>
        <label class="check">
          <input
            type="checkbox"
            checked=${params.includeAutomated === '1'}
            onChange=${e => setOpt('includeAutomated', e.target.checked ? '1' : '')}
          />
          Include automated sessions
        </label>
      </div>
    `}

    ${!submitted &&
    html`<${Empty}>
      Search across ${' '}
      <strong>every</strong> indexed Claude Code and Cursor conversation.<br />
      <span class="faint"
        >Vector matches meaning, full-text matches exact words, hybrid fuses both.</span
      >
    <//>`}
    ${loading && html`<${Spinner} label="Searching…" />`}
    ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
    ${data &&
    !loading &&
    html`
      <div class="m" style="margin:14px 2px 8px;font-size:13px;color:var(--muted)">
        <span>${data.count} result${data.count === 1 ? '' : 's'}</span>
        <${Pill}>${MODES.find(([v]) => v === params.mode)?.[1]}<//>
        ${params.source && html`<${Pill}>${sourceLabel(params.source)}<//>`}
      </div>
      ${data.results.length === 0
        ? html`<${Empty}
            >Nothing matched. Try the ${params.mode === 'text' ? 'vector' : 'full-text'} mode, or a
            broader time range.<//
          >`
        : data.results.map(
            r => html`
              <${SessionRow}
                key=${`${r.sessionId}-${r.matchedTier}`}
                session=${r}
                snippet=${r.snippet}
                tier=${r.matchedTier}
                score=${r.score}
                onClick=${() =>
                  navigate(
                    `session/${r.sessionId}`,
                    r.cursor?.messageId
                      ? { msg: r.cursor.messageId }
                      : r.cursor?.chunkIndex != null
                        ? { chunk: r.cursor.chunkIndex }
                        : {}
                  )}
              />
            `
          )}
    `}
  `
}
