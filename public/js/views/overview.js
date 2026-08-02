// Overview — the "is mindmeld healthy and what's in it" screen. Everything here
// is one glance: totals, how far behind the embedding pipeline is, which
// machines are feeding the index, and any sync error worth acting on.

import { html } from 'preact'
import { useApi } from '../api.js'
import { navigate } from '../router.js'
import { Card, Stat, Spinner, ErrorBox, Pill, Bar } from '../ui.js'
import { fmtNum, fmtExact, timeAgo, sourceLabel, pct } from '../util.js'

const Sparkline = ({ activity }) => {
  const peak = Math.max(1, ...activity.map(d => d.sessions))
  return html`
    <div class="spark">
      ${activity.map(
        d => html`
          <i
            class=${d.sessions >= peak * 0.6 ? 'hot' : ''}
            style=${`height:${Math.max(2, (d.sessions / peak) * 100)}%`}
            title=${`${d.day}: ${d.sessions} sessions, ${fmtExact(d.messages)} messages`}
          ></i>
        `
      )}
    </div>
  `
}

const SourceLine = ({ source }) => html`
  <div style="padding:8px 0;border-bottom:1px solid var(--border)">
    <div class="m" style="margin:0">
      <strong style="color:var(--text)">${sourceLabel(source.name)}</strong>
      ${source.lastSync
        ? html`<${Pill} kind="good">synced ${timeAgo(source.lastSync)}<//>`
        : html`<${Pill}>never synced<//>`}
      <span class="right faint"
        >${fmtNum(source.recordsSynced)} records · ${fmtNum(source.filesProcessed)} files</span
      >
    </div>
    ${source.lastError &&
    html`<div class="mono" style="color:var(--red);margin-top:6px;overflow-wrap:anywhere">
      ${source.lastError}
    </div>`}
  </div>
`

export const OverviewView = () => {
  const status = useApi('/status')
  const activity = useApi('/api/activity', { days: 30 })
  const machines = useApi('/api/machines')

  if (status.loading && !status.data) return html`<${Spinner} label="Reading status…" />`
  if (status.error)
    return html`<${ErrorBox} error=${status.error} onRetry=${status.reload} />`

  const s = status.data
  const totals = s?.totals ?? {}
  const pending = s?.pendingEmbeddings ?? {}
  const embedded = Number(totals.embeddings ?? 0)
  const messages = Number(totals.messages ?? 0)

  return html`
    <div class="stat-grid" style="margin-bottom:12px">
      <${Stat} n=${totals.sessions} label="Sessions" />
      <${Stat} n=${totals.messages} label="Messages" />
      <${Stat} n=${totals.projects} label="Projects" />
      <${Stat} n=${totals.embeddings} label="Embeddings" />
    </div>

    <${Card} title="Embedding coverage">
      <div class="m" style="margin:0;font-size:13px">
        <span>${pct(embedded, messages)}% of messages vectorised</span>
        <span class="right faint">${fmtExact(embedded)} / ${fmtExact(messages)}</span>
      </div>
      <${Bar} value=${embedded} total=${messages} />
      <div class="m" style="margin-top:10px">
        <${Pill} kind=${pending.messages > 0 ? 'warn' : 'good'}>
          ${fmtNum(pending.messages ?? 0)} messages pending
        <//>
        <${Pill} kind=${pending.sessions > 0 ? 'warn' : 'good'}>
          ${fmtNum(pending.sessions ?? 0)} sessions pending
        <//>
      </div>
    <//>

    ${(s?.quarantined ?? 0) > 0 &&
    html`<button class="row" style="border-color:var(--amber)" onClick=${() => navigate('quarantine')}>
      <div class="t">${fmtNum(s.quarantined)} record${s.quarantined === 1 ? '' : 's'} quarantined</div>
      <div class="m">
        <span>Kept whole and replayable — nothing was dropped.</span>
        <span class="right faint nowrap">review →</span>
      </div>
    </button>`}

    <${Card} title="Last 30 days">
      ${activity.loading && html`<${Spinner} />`}
      ${activity.error && html`<div class="faint">activity unavailable</div>`}
      ${activity.data && html`<${Sparkline} activity=${activity.data.activity} />`}
      ${s?.latestSession &&
      html`<div class="m" style="margin-top:10px">
        <span class="faint">newest:</span>
        <span>${s.latestSession.title}</span>
        <span class="right faint nowrap">${timeAgo(s.latestSession.startedAt)}</span>
      </div>`}
    <//>

    <${Card} title="Sources">
      ${(s?.sync?.sources ?? []).map(src => html`<${SourceLine} key=${src.name} source=${src} />`)}
    <//>

    <${Card} title="Vector store">
      ${(s?.chroma?.collections ?? []).length === 0
        ? html`<div class="faint">Chroma unreachable — semantic search is degraded.</div>`
        : (s?.chroma?.collections ?? []).map(
            c => html`
              <div class="m" style="margin:0;padding:5px 0">
                <span class="mono">${c.name}</span>
                <span class="right">${fmtExact(c.count)}</span>
              </div>
            `
          )}
    <//>

    <${Card} title="Machines">
      ${machines.loading && html`<${Spinner} />`}
      ${machines.data?.machines?.map(
        m => html`
          <button
            class="row"
            style="margin-bottom:6px"
            onClick=${() => navigate('logs', { machine: m.machine })}
          >
            <div class="m" style="margin:0">
              <strong style="color:var(--text)">${m.machine}</strong>
              ${m.machine === machines.data.thisMachine && html`<${Pill} kind="good">serving<//>`}
              ${m.machine === machines.data.lastIndexedMachine &&
              html`<${Pill}>last indexed<//>`}
              <span class="right faint nowrap">${timeAgo(m.lastIndexedAt) ?? 'never'}</span>
            </div>
            <div class="m faint" style="margin-top:4px">
              ${fmtNum(m.sessions)} sessions · ${fmtNum(m.messages)} messages ·
              ${fmtNum(m.projects)} projects
            </div>
          </button>
        `
      )}
    <//>

    <div class="faint" style="text-align:center;font-size:12px;padding:6px 0 20px">
      mindmeld v${s?.version} · ${machines.data?.thisMachine ?? ''}
    </div>
  `
}
