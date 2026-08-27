// Overview — the "is mindmeld healthy, and if it is idle, why" screen.
//
// The totals answer what is in the index. The rest of this screen exists for
// the harder question, because "nothing is moving" has several causes that look
// identical from a pending count: the GPU gate is holding work back while a
// game runs, Chroma is unreachable, the slow summarization phase is working
// normally and simply takes minutes per session, or someone stood ingestion
// down on purpose. Each of those has its own panel, ordered so the things you
// might act on come before the things you only read.

import { html, useState, useEffect } from 'preact'
import { useApi, apiGet } from '../api.js'
import { navigate } from '../router.js'
import { Card, Stat, Spinner, ErrorBox, Pill, Bar } from '../ui.js'
import { fmtNum, fmtExact, timeAgo, sourceLabel, pct } from '../util.js'
import { EmbeddingChart, ChartWindowPicker } from '../chart.js'
import { OllamaCard, ChromaCard, LoadCard, SummaryCard, StandDownControl } from '../health.js'

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
//
// Summarizing is a fourth thing it cannot tell apart, and it is the one most
// likely to be running when someone opens this page to ask why nothing is
// happening: the LLM pass over a session is the slowest step in the pipeline,
// and while it runs the message rate is legitimately zero. That is healthy work
// — `kind: 'good'` — not the amber the message rate alone used to earn it.
const QUEUE_STATES = {
  'caught-up': { label: 'Caught up', kind: 'good' },
  draining: { label: 'Draining', kind: 'good' },
  summarizing: { label: 'Summarizing', kind: 'good' },
  holding: { label: 'Holding steady', kind: 'warn' },
  'falling-behind': { label: 'Falling behind', kind: 'warn' },
  stalled: { label: 'Stalled', kind: 'warn' },
}

// Pluralises the noun only — the caller picks the formatter, because the pill
// wants the abbreviated count and the detail line under it wants the exact one.
const plural = (n, word) => `${word}${Number(n) === 1 ? '' : 's'}`

const QueueThroughput = () => {
  const t = useApi('/api/throughput', { minutes: 60 })

  useEffect(() => {
    const id = setInterval(t.reload, 15000)
    return () => clearInterval(id)
  }, [t.reload])

  if (t.error) return html`<div class="faint" style="margin-top:10px;font-size:13px">throughput unavailable</div>`
  if (!t.data) return null

  const { state, queue, rates, eta, window: w } = t.data
  const meta = QUEUE_STATES[state] ?? { label: state, kind: '' }
  const etaText = fmtDuration(eta.secondsRemaining)
  const summariesPending = queue?.summariesPending ?? 0

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
      ${state === 'summarizing' &&
      html`<span
        >summarizing ${fmtNum(summariesPending)} ${plural(summariesPending, 'session')} —
        ${queue.pending === 0
          ? 'no messages queued to embed'
          : `no messages embedded in the last ${w.minutes}m`}</span
      >`}
      ${state === 'stalled' &&
      html`<span>nothing embedded or summarized in the last ${w.minutes}m</span>`}
      ${etaText && state === 'draining' &&
      html`<span class="right faint nowrap">~${etaText} remaining</span>`}
    </div>
    <div class="faint" style="font-size:12px;margin-top:4px">
      last ${w.minutes}m: ${fmtExact(w.embedded)} embedded, ${fmtExact(w.arrived)} arrived,
      ${fmtExact(w.summarized ?? 0)} summarized
      ${eta.finishesAt && state === 'draining'
        ? html` · done ${new Date(eta.finishesAt).toLocaleString()}`
        : ''}
    </div>
    <div class="faint" style="font-size:12px;margin-top:2px">
      ${fmtExact(summariesPending)} ${plural(summariesPending, 'session')} awaiting a summary
      ${(w.summarized ?? 0) > 0 ? ` · ${fmtNum(rates.summarizedPerMinute)}/min` : ''}
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

// Two different populations wear the word "machine" on this screen, and the
// card used to conflate them. `machines` is sync activity: everything that has
// ever fed a conversation into the index. The logs table's `machine` column is
// written by the log sink, so it only ever names processes that *ship* logs. A
// device that syncs conversations but runs no mindmeld service is in the first
// list and absent from the second, and a log link for it opens a page that is
// empty by construction (#112).
//
// Both questions are worth answering, so neither list is discarded: sync
// activity still drives the card, the log link only renders for a machine that
// actually writes logs, and machines that ship logs without syncing get a
// section of their own instead of being unreachable from this screen.
const logTotals = writers => {
  const byMachine = new Map()
  for (const w of writers) {
    const acc = byMachine.get(w.machine) ?? { machine: w.machine, entries: 0, lastLoggedAt: null }
    acc.entries += Number(w.entries ?? 0)
    if (!acc.lastLoggedAt || w.lastLoggedAt > acc.lastLoggedAt) acc.lastLoggedAt = w.lastLoggedAt
    byMachine.set(w.machine, acc)
  }
  return [...byMachine.values()].sort((a, b) => (a.lastLoggedAt < b.lastLoggedAt ? 1 : -1))
}

// Same row shape either way — only the one that leads somewhere is a button.
// `.inert` drops the pointer cursor and the press state, so "no logs" reads as
// a fact about the machine rather than a link that failed.
const SyncMachineRow = ({ m, thisMachine, lastIndexedMachine, hasLogs }) => {
  const body = html`
    <div class="m" style="margin:0">
      <strong style="color:var(--text)">${m.machine}</strong>
      ${m.machine === thisMachine && html`<${Pill} kind="good">serving<//>`}
      ${m.machine === lastIndexedMachine && html`<${Pill}>last indexed<//>`}
      <span class="right faint nowrap">${timeAgo(m.lastIndexedAt) ?? 'never'}</span>
    </div>
    <div class="m faint" style="margin-top:4px">
      <span>
        ${fmtNum(m.sessions)} sessions · ${fmtNum(m.messages)} messages ·
        ${fmtNum(m.projects)} projects
      </span>
      <span class="right nowrap">${hasLogs ? 'logs →' : 'no logs'}</span>
    </div>
  `
  return hasLogs
    ? html`<button
        class="row"
        style="margin-bottom:6px"
        onClick=${() => navigate('logs', { machine: m.machine })}
      >
        ${body}
      </button>`
    : html`<div
        class="row inert"
        style="margin-bottom:6px"
        title="Syncs conversations but runs no mindmeld service, so it ships no logs"
      >
        ${body}
      </div>`
}

const LogOnlyRow = ({ w }) => html`
  <button
    class="row"
    style="margin-bottom:6px"
    onClick=${() => navigate('logs', { machine: w.machine })}
  >
    <div class="m" style="margin:0">
      <strong style="color:var(--text)">${w.machine}</strong>
      <span class="right faint nowrap">${timeAgo(w.lastLoggedAt) ?? 'never'}</span>
    </div>
    <div class="m faint" style="margin-top:4px">
      <span>${fmtNum(w.entries)} log ${w.entries === 1 ? 'entry' : 'entries'}</span>
      <span class="right nowrap">logs →</span>
    </div>
  </button>
`

const MachinesCard = ({ machines }) => {
  const data = machines.data
  const synced = data?.machines ?? []
  const writers = logTotals(data?.logWriters ?? [])
  const shipsLogs = new Set(writers.map(w => w.machine))
  const syncedNames = new Set(synced.map(m => m.machine))
  const logOnly = writers.filter(w => !syncedNames.has(w.machine))

  return html`
    <${Card} title="Machines">
      ${machines.loading && html`<${Spinner} />`}
      ${synced.map(
        m => html`<${SyncMachineRow}
          key=${m.machine}
          m=${m}
          thisMachine=${data.thisMachine}
          lastIndexedMachine=${data.lastIndexedMachine}
          hasLogs=${shipsLogs.has(m.machine)}
        />`
      )}
      ${logOnly.length > 0 &&
      html`
        <div class="faint" style="margin:14px 0 6px;font-size:12px">
          Ships logs, syncs no conversations
        </div>
        ${logOnly.map(w => html`<${LogOnlyRow} key=${w.machine} w=${w} />`)}
      `}
    <//>
  `
}

// How often the live numbers refresh. The queue moves in the tens-to-hundreds
// per minute, so a status read that only happens on navigation is stale within
// seconds of opening the page — and this screen exists to answer "what is it
// doing right now".
const STATUS_REFRESH_MS = 10000

// The gate flips between holding and open on its own schedule, and a resident
// model can drop out of VRAM at any moment, so the dependency panels are
// refreshed on the same beat as the totals. The chart is a rollup over hours —
// re-fetching it that often would be waste.
const SERIES_REFRESH_MS = 30000

// The graph of the pipeline over time, with its window picker. Lives here
// rather than in chart.js so the chart module stays presentational and this
// keeps the fetching.
const EmbeddingActivity = () => {
  const [minutes, setMinutes] = useState(360)
  const series = useApi('/api/embedding-series', { minutes }, String(minutes))

  useEffect(() => {
    const id = setInterval(series.reload, SERIES_REFRESH_MS)
    return () => clearInterval(id)
  }, [series.reload])

  return html`
    <${Card}
      title="Embedding activity"
      action=${html`<${ChartWindowPicker} value=${minutes} onChange=${setMinutes} />`}
    >
      ${series.loading && !series.data && html`<${Spinner} />`}
      ${series.error && html`<div class="faint">activity unavailable</div>`}
      ${series.data && html`<${EmbeddingChart} series=${series.data} />`}
    <//>
  `
}

export const OverviewView = () => {
  const status = useApi('/status')
  const activity = useApi('/api/activity', { days: 30 })
  const machines = useApi('/api/machines')
  const system = useApi('/api/system')
  const summaries = useApi('/api/summaries')

  // Totals, embedding coverage, pending counts and the quarantine badge all
  // come from /status, so refreshing it refreshes the whole screen. Activity is
  // a 30-day rollup and machines change on a sync cycle; neither is worth a
  // request every ten seconds.
  useEffect(() => {
    const id = setInterval(() => {
      status.reload()
      system.reload()
      summaries.reload()
    }, STATUS_REFRESH_MS)
    return () => clearInterval(id)
  }, [status.reload, system.reload, summaries.reload])

  if (status.loading && !status.data) return html`<${Spinner} label="Reading status…" />`
  // Only surrender the screen when there is nothing to show. Once a refresh has
  // succeeded even once, a later failure is reported in place (below) over the
  // last known numbers rather than replacing them.
  if (status.error && !status.data)
    return html`<${ErrorBox} error=${status.error} onRetry=${status.reload} />`

  const s = status.data
  const totals = s?.totals ?? {}
  const pending = s?.pendingEmbeddings ?? {}
  const embedded = Number(totals.embeddings ?? 0)
  const messages = Number(totals.messages ?? 0)

  return html`
    ${status.error &&
    html`<div class="m faint" style="margin-bottom:10px;font-size:12px">
      <span style="color:var(--amber)">●</span>
      <span>showing last known values — refresh failed: ${status.error}</span>
    </div>`}

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

    <${EmbeddingActivity} />

    <${StandDownControl} onChange=${system.reload} />

    <${LoadCard} system=${system} />

    <${OllamaCard} system=${system} />

    <${SummaryCard} summaries=${summaries} />

    <${ChromaCard} system=${system} />

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

    <${MachinesCard} machines=${machines} />

    <div class="faint" style="text-align:center;font-size:12px;padding:6px 0 20px">
      mindmeld v${s?.version} · ${machines.data?.thisMachine ?? ''}
    </div>
  `
}
