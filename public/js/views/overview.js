// Overview — the "is mindmeld healthy and what's in it" screen. Everything here
// is one glance: totals, how far behind the embedding pipeline is, which
// machines are feeding the index, and any sync error worth acting on.

import { html, useState, useEffect } from 'preact'
import { useApi, apiGet } from '../api.js'
import { navigate } from '../router.js'
import { Card, Stat, Spinner, ErrorBox, Pill, Bar } from '../ui.js'
import { fmtNum, fmtExact, timeAgo, sourceLabel, pct } from '../util.js'

// POST /api/sync answers 202 when it starts a run and 409 when one was already
// in flight — neither is a failure, and both carry the run's state, so this
// only treats an explicit error body as one.
const requestRun = async () => {
  const res = await fetch('/api/sync', { method: 'POST', headers: { accept: 'application/json' } })
  const body = await res.json()
  if (body.status === 'error') throw new Error(body.error)
  return body
}

const runSummary = run => {
  if (run.error) return null
  const seconds = run.durationMs != null ? Math.max(1, Math.round(run.durationMs / 1000)) : null
  const parts = [
    `embedded ${fmtNum(run.messagesEmbedded)} message${run.messagesEmbedded === 1 ? '' : 's'}`,
    `updated ${fmtNum(run.sessionsUpdated)} session${run.sessionsUpdated === 1 ? '' : 's'}`,
  ]
  return `${parts.join(', ')}${seconds ? ` in ${seconds}s` : ''}`
}

const fmtDuration = seconds => {
  if (seconds == null) return null
  if (seconds < 90) return `${Math.round(seconds)}s`
  const mins = Math.round(seconds / 60)
  if (mins < 90) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  if (hours < 48) return rem ? `${hours}h ${rem}m` : `${hours}h`
  return `${Math.round(hours / 24)}d`
}

// A pending count alone cannot tell "working through it" from "stopped" from
// "losing ground", so the state is what gets the pill and the rate explains it.
const QUEUE_STATES = {
  'caught-up': { label: 'Caught up', kind: 'good' },
  draining: { label: 'Draining', kind: 'good' },
  holding: { label: 'Holding steady', kind: 'warn' },
  'falling-behind': { label: 'Falling behind', kind: 'warn' },
  stalled: { label: 'Stalled', kind: 'warn' },
}

const QueueThroughput = () => {
  const t = useApi('/api/throughput', { minutes: 60 })

  useEffect(() => {
    const id = setInterval(t.reload, 15000)
    return () => clearInterval(id)
  }, [t.reload])

  if (t.error) return html`<div class="faint" style="margin-top:10px;font-size:13px">throughput unavailable</div>`
  if (!t.data) return null

  const { state, rates, eta, window: w } = t.data
  const meta = QUEUE_STATES[state] ?? { label: state, kind: '' }
  const etaText = fmtDuration(eta.secondsRemaining)

  return html`
    <div class="m" style="margin-top:10px">
      <${Pill} kind=${meta.kind}>${meta.label}<//>
      ${state === 'draining' &&
      html`<span>${fmtNum(rates.netDrainPerMinute)}/min net</span>`}
      ${state === 'falling-behind' &&
      html`<span
        >arriving ${fmtNum(rates.arrivedPerMinute)}/min vs ${fmtNum(rates.embeddedPerMinute)}/min
        embedded</span
      >`}
      ${state === 'holding' && html`<span>${fmtNum(rates.embeddedPerMinute)}/min in and out</span>`}
      ${state === 'stalled' &&
      html`<span>nothing embedded in the last ${w.minutes}m</span>`}
      ${etaText && state === 'draining' &&
      html`<span class="right faint nowrap">~${etaText} remaining</span>`}
    </div>
    <div class="faint" style="font-size:12px;margin-top:4px">
      last ${w.minutes}m: ${fmtExact(w.embedded)} embedded, ${fmtExact(w.arrived)} arrived
      ${eta.finishesAt && state === 'draining'
        ? html` · done ${new Date(eta.finishesAt).toLocaleString()}`
        : ''}
    </div>
  `
}

// Drains pending embeddings on demand instead of waiting out the sync interval.
// The run is detached server-side and takes minutes, so this polls rather than
// holding a request open, and it picks up a run someone else started too.
const IngestionRunner = ({ onFinished }) => {
  const [run, setRun] = useState(null)
  const [error, setError] = useState(null)
  const [pressing, setPressing] = useState(false)

  useEffect(() => {
    apiGet('/api/sync')
      .then(body => setRun(body.run))
      .catch(() => {}) // an older server without this route just shows the button
  }, [])

  useEffect(() => {
    if (!run?.running) return
    let live = true
    const id = setInterval(async () => {
      try {
        const body = await apiGet('/api/sync')
        if (!live) return
        setRun(body.run)
        if (!body.run.running) onFinished?.()
      } catch (e) {
        if (live) setError(e.message)
      }
    }, 2000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [run?.running])

  const start = async () => {
    setError(null)
    setPressing(true)
    try {
      setRun((await requestRun()).run)
    } catch (e) {
      setError(e.message)
    } finally {
      setPressing(false)
    }
  }

  const running = !!run?.running

  return html`
    <div style="margin-top:12px">
      <button class="btn sm primary" disabled=${running || pressing} onClick=${start}>
        ${running ? 'Ingesting…' : 'Run ingestion now'}
      </button>
      ${running &&
      html`<span class="faint" style="margin-left:10px;font-size:13px">
        started ${timeAgo(run.startedAt)} — embedding pending messages
      </span>`}
      ${!running &&
      run?.finishedAt &&
      !run.error &&
      html`<span class="faint" style="margin-left:10px;font-size:13px">
        last run ${timeAgo(run.finishedAt)}: ${runSummary(run)}
      </span>`}
      ${!running &&
      run?.error &&
      html`<div class="mono" style="color:var(--red);margin-top:8px;overflow-wrap:anywhere">
        last run failed: ${run.error}
      </div>`}
      ${error &&
      html`<div class="mono" style="color:var(--red);margin-top:8px;overflow-wrap:anywhere">
        ${error}
      </div>`}
    </div>
  `
}

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
      <${QueueThroughput} />
      <${IngestionRunner} onFinished=${status.reload} />
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
        <span class=${s.latestSession.title ? '' : 'faint'}
          >${s.latestSession.title ?? 'no title yet — not summarized'}</span
        >
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
