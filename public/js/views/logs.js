// Logs — every mindmeld process ships console output to a shared table, so this
// is the sync container's view too, not just the server you're talking to.

import { html, useState, useEffect } from 'preact'
import { useApi } from '../api.js'
import { useRoute, navigate } from '../router.js'
import { Spinner, ErrorBox, Empty, Pill } from '../ui.js'
import { timeAgo, fmtDateTime, fmtNum } from '../util.js'

const PAGE = 100
const LEVELS = [
  ['', 'All'],
  ['error', 'Errors'],
  ['warn', 'Warnings'],
  ['log', 'Info'],
]

export const LogsView = () => {
  const { query } = useRoute()
  const [contains, setContains] = useState(query.contains ?? '')
  const [live, setLive] = useState(false)
  const offset = Number(query.offset ?? 0)

  const params = {
    limit: PAGE,
    offset,
    level: query.level ?? '',
    machine: query.machine ?? '',
    service: query.service ?? '',
    contains: query.contains ?? '',
  }
  const { data, error, loading, reload } = useApi('/api/logs', params, params)

  useEffect(() => {
    if (!live) return
    const t = setInterval(reload, 5000)
    return () => clearInterval(t)
  }, [live, reload])

  const setOpt = (key, value) => navigate('logs', { ...query, offset: '', [key]: value })

  const writers = data?.logWriters ?? []
  const machineNames = [...new Set(writers.map(w => w.machine))]
  const services = [...new Set(writers.map(w => w.service))]

  // "No lines match those filters" blames the filter for a mismatch that is
  // structural: a machine that syncs conversations but runs no mindmeld service
  // never writes a log row, so no amount of widening the other filters will
  // produce one. Say which of the two it is (#112).
  const emptyReason = () => {
    const machine = query.machine ?? ''
    if (!machine || machineNames.includes(machine)) return 'No log lines match those filters.'
    return (data?.machines ?? []).some(m => m.machine === machine)
      ? `${machine} syncs conversations into the index but ships no logs — only machines running a mindmeld service write log lines.`
      : `No machine named ${machine} has ever shipped a log line.`
  }

  return html`
    <form
      class="search-bar"
      onSubmit=${e => {
        e.preventDefault()
        setOpt('contains', contains.trim())
      }}
    >
      <input
        type="search"
        placeholder="Contains…"
        value=${contains}
        onInput=${e => setContains(e.target.value)}
      />
      <button class="btn" type="submit">Filter</button>
    </form>

    <div class="seg" style="margin-bottom:8px">
      ${LEVELS.map(
        ([v, l]) => html`
          <button class=${(query.level ?? '') === v ? 'on' : ''} onClick=${() => setOpt('level', v)}>
            ${l}
          </button>
        `
      )}
    </div>

    <div class="filters">
      <select value=${query.machine ?? ''} onChange=${e => setOpt('machine', e.target.value)}>
        <option value="">All machines</option>
        ${machineNames.map(m => html`<option value=${m}>${m}</option>`)}
      </select>
      <select value=${query.service ?? ''} onChange=${e => setOpt('service', e.target.value)}>
        <option value="">All services</option>
        ${services.map(s => html`<option value=${s}>${s}</option>`)}
      </select>
      <label class="check">
        <input type="checkbox" checked=${live} onChange=${e => setLive(e.target.checked)} />
        live
      </label>
    </div>

    ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
    ${loading && !data && html`<${Spinner} label="Reading logs…" />`}
    ${data &&
    html`
      <div class="faint" style="font-size:12px;margin:6px 2px">
        ${fmtNum(data.total)} entries${query.machine ? ` on ${query.machine}` : ''} · buffered
        ${data.sink?.queued ?? 0}
      </div>
      ${data.entries.length === 0 &&
      html`<${Empty}>
        ${emptyReason()}
        ${query.machine &&
        html`<div style="margin-top:12px">
          <button class="btn sm" onClick=${() => setOpt('machine', '')}>Show all machines</button>
        </div>`}
      <//>`}
      ${data.entries.map(
        e => html`
          <div class="logline ${e.level}" key=${e.id}>
            <div class="meta">
              <span>${fmtDateTime(e.loggedAt)}</span>
              <span>${e.machine}/${e.service}</span>
              <span class="right">${timeAgo(e.loggedAt)}</span>
            </div>
            <div>${e.message}</div>
          </div>
        `
      )}
      ${data.total > PAGE &&
      html`<div class="pager">
        <button
          class="btn sm"
          disabled=${offset === 0}
          onClick=${() => navigate('logs', { ...query, offset: Math.max(0, offset - PAGE) })}
        >
          ← Newer
        </button>
        <button
          class="btn sm"
          disabled=${offset + PAGE >= data.total}
          onClick=${() => navigate('logs', { ...query, offset: offset + PAGE })}
        >
          Older →
        </button>
        <span class="right faint">${offset + 1}–${offset + data.returned}</span>
      </div>`}
    `}
  `
}
