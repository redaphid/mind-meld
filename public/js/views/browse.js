// Browse — the inventory. Projects first (that's how you think about your own
// work), then the sessions inside one, with a title filter for when you half
// remember a name and don't want to run a search.

import { html, useState } from 'preact'
import { useApi } from '../api.js'
import { useRoute, navigate } from '../router.js'
import { Card, Spinner, ErrorBox, Empty, Pill, SessionRow } from '../ui.js'
import { fmtNum, timeAgo, sourceLabel, shortPath } from '../util.js'

const PAGE = 30

const ProjectList = () => {
  const [filter, setFilter] = useState('')
  const { data, error, loading, reload } = useApi('/api/projects')

  if (loading && !data) return html`<${Spinner} label="Loading projects…" />`
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`

  const needle = filter.trim().toLowerCase()
  const projects = (data?.projects ?? []).filter(
    p =>
      !needle ||
      (p.name ?? '').toLowerCase().includes(needle) ||
      (p.path ?? '').toLowerCase().includes(needle)
  )

  return html`
    <div class="search-bar">
      <input
        type="search"
        placeholder="Filter ${data?.count ?? 0} projects…"
        value=${filter}
        onInput=${e => setFilter(e.target.value)}
      />
    </div>
    ${projects.length === 0 && html`<${Empty}>No project matches “${filter}”.<//>`}
    ${projects.map(
      p => html`
        <button
          key=${p.id}
          class="row"
          onClick=${() => navigate('browse', { project: p.id })}
        >
          <div class="t">${p.name ?? 'unnamed'}</div>
          <div class="m">
            <${Pill}>${sourceLabel(p.source)}<//>
            <span>${fmtNum(p.sessions)} sessions</span>
            <span>${fmtNum(p.messages)} msgs</span>
            <span class="right faint nowrap">${timeAgo(p.lastActivityAt) ?? 'no activity'}</span>
          </div>
          ${p.path && html`<div class="s mono faint">${shortPath(p.path)}</div>`}
        </button>
      `
    )}
  `
}

const SessionList = ({ projectId }) => {
  const { query } = useRoute()
  const [titleFilter, setTitleFilter] = useState(query.q ?? '')
  const offset = Number(query.offset ?? 0)
  const includeAutomated = query.automated === '1'

  const params = {
    projectId,
    offset,
    limit: PAGE,
    q: titleFilter.trim() || undefined,
    includeAutomated: includeAutomated ? '1' : '',
  }
  const { data, error, loading, reload } = useApi('/api/sessions', params, params)

  const setOffset = next => navigate('browse', { ...query, offset: next })

  return html`
    <div class="backbar">
      <button class="btn sm" onClick=${() => navigate('browse')}>← Projects</button>
      <label class="check right">
        <input
          type="checkbox"
          checked=${includeAutomated}
          onChange=${e => navigate('browse', { ...query, automated: e.target.checked ? '1' : '' })}
        />
        automated
      </label>
    </div>

    <div class="search-bar">
      <input
        type="search"
        placeholder="Filter by title…"
        value=${titleFilter}
        onInput=${e => setTitleFilter(e.target.value)}
      />
    </div>

    ${loading && html`<${Spinner} />`}
    ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
    ${data &&
    !loading &&
    html`
      <div class="faint" style="font-size:13px;margin:4px 2px 10px">
        ${data.total} session${data.total === 1 ? '' : 's'}
        ${data.total > PAGE ? ` · showing ${offset + 1}–${offset + data.count}` : ''}
      </div>
      ${data.sessions.length === 0 && html`<${Empty}>Nothing here.<//>`}
      ${data.sessions.map(
        sn => html`<${SessionRow} key=${sn.id} session=${sn} snippet=${sn.summary} />`
      )}
      ${data.total > PAGE &&
      html`<div class="pager">
        <button class="btn sm" disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - PAGE))}>
          ← Newer
        </button>
        <button
          class="btn sm"
          disabled=${offset + PAGE >= data.total}
          onClick=${() => setOffset(offset + PAGE)}
        >
          Older →
        </button>
      </div>`}
    `}
  `
}

export const BrowseView = () => {
  const { query } = useRoute()
  return query.project
    ? html`<${SessionList} projectId=${query.project} />`
    : html`<${ProjectList} />`
}
