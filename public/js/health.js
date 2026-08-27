// The dependency panels on the overview: the Ollama gate, Chroma, machine load,
// and the summarization phase — plus the control that tells ingestion to get
// off the GPU.
//
// These exist because "nothing is happening" has several completely different
// causes that look identical from the totals: the gate is holding work back
// because a game has the card, Chroma is unreachable so nothing can be written,
// or the slow phase is running normally and simply takes minutes per session.
// Each panel is written to distinguish its own case from the others.

import { html, useState, useEffect, useCallback } from 'preact'
import { apiGet } from './api.js'
import { Card, Pill, Spinner, Bar } from './ui.js'
import { fmtNum, fmtExact, timeAgo } from './util.js'

const GB = 1024 * 1024 * 1024
const fmtGb = bytes => `${(bytes / GB).toFixed(1)} GB`
const fmtMbAsGb = mb => `${(mb / 1024).toFixed(1)} GB`

const fmtCountdown = seconds => {
  if (seconds == null) return null
  if (seconds <= 0) return 'now'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}

// ---------------------------------------------------------------- Ollama gate

// The gate has three states worth telling apart, and only one of them is a
// fault. "Holding" is the proxy working exactly as designed — mindmeld yielding
// the card to a game or ComfyUI — and must not be dressed as an error, or the
// dashboard cries wolf every evening.
const gateVerdict = ollama => {
  if (!ollama.reachable)
    return { kind: 'bad', label: 'Unreachable', note: ollama.error }
  if (!ollama.gate.present)
    return {
      kind: '',
      label: 'Direct Ollama',
      note: 'No gate in front of this Ollama — GPU work is not being yielded to anything else.',
    }
  if (ollama.gate.open) return { kind: 'good', label: 'Open', note: ollama.gate.status }
  return { kind: 'warn', label: 'Holding', note: ollama.gate.status }
}

export const OllamaCard = ({ system }) => {
  const s = system.data
  if (!s) return html`<${Card} title="Ollama gate">${system.loading && html`<${Spinner} />`}<//>`

  const o = s.ollama
  const g = o.gate
  const verdict = gateVerdict(o)
  const quietPct =
    g.requiredQuietSeconds > 0 ? Math.min(100, (g.quietSeconds / g.requiredQuietSeconds) * 100) : 0

  return html`
    <${Card} title="Ollama gate">
      <div class="m" style="margin:0">
        <${Pill} kind=${verdict.kind}>${verdict.label}<//>
        ${o.version && html`<span class="faint">v${o.version}</span>`}
        <span class="right mono faint" style="font-size:12px">${o.url}</span>
      </div>

      ${verdict.note &&
      html`<div class="faint" style="font-size:12px;margin-top:8px;line-height:1.5">
        ${verdict.note}
      </div>`}

      ${g.present &&
      !g.open &&
      g.requiredQuietSeconds > 0 &&
      html`
        <div class="m" style="margin-top:10px;font-size:12px">
          <span class="faint">GPU must be quiet for</span>
          <span
            >${fmtCountdown(g.quietSeconds)} / ${fmtCountdown(g.requiredQuietSeconds)}</span
          >
        </div>
        <${Bar} value=${quietPct} total=${100} tone="var(--amber)" />
      `}

      <div class="m" style="margin-top:12px;font-size:12px">
        <span class="faint">configured</span>
        <span class="mono">${o.configured.embedding}</span>
        <span class="mono">${o.configured.summarize}</span>
      </div>

      <div class="faint" style="font-size:12px;margin-top:12px">
        Resident in VRAM ${o.models.length > 0 ? `· ${fmtGb(o.vramBytesTotal)}` : ''}
      </div>
      ${o.models.length === 0
        ? html`<div class="faint" style="font-size:12px;margin-top:4px">
            nothing loaded — the next request pays the load cost
          </div>`
        : o.models.map(
            m => html`
              <div class="m" style="margin:6px 0 0;font-size:12px">
                <span class="mono">${m.name}</span>
                ${m.ours
                  ? html`<${Pill} kind="good">ours<//>`
                  : html`<${Pill} kind="warn" title="Not a model mindmeld uses — another tenant is holding VRAM">
                      someone else
                    <//>`}
                <span class="right faint">${fmtGb(m.sizeVramBytes)}</span>
              </div>
            `
          )}
    <//>
  `
}

// --------------------------------------------------------------------- Chroma

export const ChromaCard = ({ system }) => {
  const s = system.data
  if (!s) return html`<${Card} title="Vector store">${system.loading && html`<${Spinner} />`}<//>`
  const c = s.chroma

  return html`
    <${Card} title="Vector store">
      <div class="m" style="margin:0">
        ${c.reachable
          ? html`<${Pill} kind="good">Reachable<//>`
          : html`<${Pill} kind="bad">Unreachable<//>`}
        ${c.latencyMs != null && html`<span class="faint">${c.latencyMs}ms</span>`}
        <span class="right mono faint" style="font-size:12px">${c.url}</span>
      </div>

      ${!c.reachable &&
      html`<div class="mono" style="color:var(--red);margin-top:8px;overflow-wrap:anywhere;font-size:12px">
        ${c.error}
      </div>
      <div class="faint" style="font-size:12px;margin-top:6px">
        Semantic search is degraded and nothing new can be vectorised until this recovers.
      </div>`}

      ${c.collections.map(
        col => html`
          <div class="m" style="margin:0;padding:5px 0;font-size:13px">
            <span class="mono">${col.name}</span>
            <span class="right">${fmtExact(col.count)}</span>
          </div>
        `
      )}
    <//>
  `
}

// ----------------------------------------------------------------- Load (CPU/GPU)

// Load is reported as a share of cores because a raw load average means
// nothing without knowing the core count — 8.0 is saturated on 8 cores and
// idle-ish on 64.
const loadKind = perCore => (perCore >= 1 ? 'bad' : perCore >= 0.7 ? 'warn' : 'good')

export const LoadCard = ({ system }) => {
  const s = system.data
  if (!s) return html`<${Card} title="Machine load">${system.loading && html`<${Spinner} />`}<//>`

  const { cpu, ollama } = s
  const g = ollama.gate
  const memUsed = cpu.memory.totalBytes - cpu.memory.freeBytes

  return html`
    <${Card} title="Machine load">
      ${cpu.loadAvailable
        ? html`
            <div class="m" style="margin:0">
              <${Pill} kind=${loadKind(cpu.loadPerCore)}>
                CPU ${Math.round(cpu.loadPerCore * 100)}%
              <//>
              <span class="faint" style="font-size:12px">
                load ${cpu.load1.toFixed(2)} / ${cpu.load5.toFixed(2)} / ${cpu.load15.toFixed(2)}
                over ${cpu.cores} cores
              </span>
            </div>
            <${Bar} value=${Math.min(cpu.loadPerCore, 1)} total=${1} />
            <div class="faint" style="font-size:11px;margin-top:4px">
              Containers only — this is the Docker VM's load, not the whole host's.
            </div>
          `
        : html`
            <div class="m" style="margin:0">
              <${Pill}>CPU not measured<//>
              <span class="faint" style="font-size:12px">${cpu.cores} cores</span>
            </div>
            <div class="faint" style="font-size:11px;margin-top:4px">
              This server is running on Windows, which has no load average. An empty bar here
              would read as idle rather than as unmeasured.
            </div>
          `}

      <div class="m" style="margin-top:14px">
        ${g.gpuInUseNow === null
          ? html`<${Pill}>GPU unknown<//>`
          : g.gpuInUseNow
            ? html`<${Pill} kind="warn">GPU busy<//>`
            : html`<${Pill} kind="good">GPU free<//>`}
        ${g.otherVramMb != null &&
        html`<span class="faint" style="font-size:12px">
          ${fmtMbAsGb(g.otherVramMb)} held by other programs
          ${g.busyThresholdMb != null ? ` · over ${fmtMbAsGb(g.busyThresholdMb)} counts as busy` : ''}
        </span>`}
      </div>
      ${g.otherVramMb != null &&
      g.busyThresholdMb > 0 &&
      html`<${Bar}
        value=${Math.min(g.otherVramMb, g.busyThresholdMb * 2)}
        total=${g.busyThresholdMb * 2}
        tone=${g.gpuInUseNow ? 'var(--amber)' : 'var(--green)'}
      />`}
      <div class="faint" style="font-size:11px;margin-top:4px">
        ${g.present
          ? 'VRAM held by non-Ollama processes, measured by the gate. No container here has GPU access.'
          : 'No gate present, so GPU load cannot be measured from inside a container.'}
      </div>

      <div class="m" style="margin-top:14px;font-size:12px">
        <span class="faint">memory</span>
        <span>${fmtGb(memUsed)} / ${fmtGb(cpu.memory.totalBytes)}</span>
        <span class="right faint">up ${fmtCountdown(cpu.uptimeSeconds)}</span>
      </div>
    <//>
  `
}

// ------------------------------------------------------------------ Summaries

export const SummaryCard = ({ summaries }) => {
  const s = summaries.data
  if (!s) return html`<${Card} title="Summarization">${summaries.loading && html`<${Spinner} />`}<//>`

  const dupes = s.active.filter(a => a.workers > 1)

  return html`
    <${Card} title="Summarization">
      <div class="m" style="margin:0">
        ${s.active.length > 0
          ? html`<${Pill} kind="good">Working ${s.active.length}<//>`
          : s.sessions.pending > 0
            ? html`<${Pill} kind="warn">Idle<//>`
            : html`<${Pill} kind="good">Caught up<//>`}
        <span class="faint" style="font-size:12px">
          ${fmtNum(s.sessions.summarized)} of ${fmtNum(s.sessions.total)} sessions summarized
        </span>
        <span class="right mono faint" style="font-size:12px">${s.model}</span>
      </div>
      <${Bar} value=${s.sessions.summarized} total=${s.sessions.total} />

      <div class="m" style="margin-top:10px;font-size:12px">
        <span>${fmtExact(s.sessions.pending)} awaiting a summary</span>
        ${s.oldestPendingStartedAt &&
        html`<span class="right faint">oldest from ${timeAgo(s.oldestPendingStartedAt)}</span>`}
      </div>

      ${s.active.length > 0 &&
      html`
        <div class="faint" style="font-size:12px;margin-top:14px">Being summarized now</div>
        ${s.active.map(
          a => html`
            <div class="m" style="margin:6px 0 0;font-size:12px">
              <span class="mono">session ${a.sessionId}</span>
              <span class="faint">${a.chunkPasses} chunk passes</span>
              ${a.workers > 1 &&
              html`<${Pill} kind="bad" title="The embedding queue is global and nothing claims a row, so these workers are duplicating each other's LLM work">
                ${a.workers} workers
              <//>`}
              <span class="right faint">${timeAgo(a.lastAt)}</span>
            </div>
          `
        )}
      `}

      ${dupes.length > 0 &&
      html`<div class="faint" style="font-size:11px;margin-top:8px;line-height:1.5">
        ${dupes.length} ${dupes.length === 1 ? 'session is' : 'sessions are'} being worked by more
        than one worker at once. The queue is global and unclaimed, so that work is duplicated and
        the loser's output is discarded.
      </div>`}

      ${s.recent.length > 0 &&
      html`
        <div class="faint" style="font-size:12px;margin-top:14px">Most recent</div>
        ${s.recent.map(
          r => html`
            <div class="m" style="margin:6px 0 0;font-size:12px">
              <span class=${r.title ? '' : 'faint'}>${r.title ?? `session ${r.id}`}</span>
              <span class="right faint nowrap">${timeAgo(r.at)}</span>
            </div>
          `
        )}
      `}
    <//>
  `
}

// ------------------------------------------------------------------ Stand down

const STAND_DOWN_CHOICES = [15, 60, 120]

// "Get off the GPU" as a button.
//
// It polls while a stand-down is live so the countdown is honest even if
// someone pressed it on another device, and it counts down locally between
// polls rather than re-deriving the remaining time from `until` against a
// client clock that may not agree with the server's.
export const StandDownControl = ({ onChange }) => {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setState(await apiGet('/api/stand-down'))
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Local tick while standing down, plus a reconcile against the server every
  // 15s so another device's press or release shows up here.
  useEffect(() => {
    if (!state?.standingDown) return
    const tick = setInterval(
      () =>
        setState(s =>
          s?.standingDown ? { ...s, secondsRemaining: Math.max(0, s.secondsRemaining - 1) } : s
        ),
      1000
    )
    const sync = setInterval(load, 15000)
    return () => {
      clearInterval(tick)
      clearInterval(sync)
    }
  }, [state?.standingDown, load])

  // A lapsed deadline is the normal way a stand-down ends, so when the local
  // countdown hits zero the server is asked once rather than the UI simply
  // assuming work resumed.
  useEffect(() => {
    if (state?.standingDown && state.secondsRemaining === 0) load()
  }, [state?.standingDown, state?.secondsRemaining, load])

  const post = async (path, body) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json()
      if (json.status === 'error') throw new Error(json.error)
      setState(json)
      onChange?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const standing = !!state?.standingDown

  return html`
    <${Card} title="Ingestion">
      ${standing
        ? html`
            <div class="m" style="margin:0">
              <${Pill} kind="warn">Standing down<//>
              <span>resumes in ${fmtCountdown(state.secondsRemaining)}</span>
              ${state.reason && html`<span class="faint">· ${state.reason}</span>`}
            </div>
            <div class="faint" style="font-size:12px;margin-top:8px;line-height:1.5">
              Workers stop at their next checkpoint and the GPU is left alone. Conversations keep
              being indexed — only their vectors wait.
            </div>
            <div style="margin-top:12px">
              <button class="btn sm primary" disabled=${busy} onClick=${() => post('/api/stand-down/resume')}>
                Resume now
              </button>
            </div>
          `
        : html`
            <div class="faint" style="font-size:13px;line-height:1.5">
              Embedding and summarization hold the GPU for minutes at a time. Stand down to get it
              back for a game or a render — work resumes on its own afterwards.
            </div>
            <div class="m" style="margin-top:12px">
              ${STAND_DOWN_CHOICES.map(
                m => html`<button
                  class="btn sm"
                  disabled=${busy}
                  onClick=${() => post('/api/stand-down', { minutes: m, reason: 'asked from the dashboard' })}
                >
                  Stand down ${m < 60 ? `${m}m` : `${m / 60}h`}
                </button>`
              )}
            </div>
          `}
      ${error &&
      html`<div class="mono" style="color:var(--red);margin-top:8px;overflow-wrap:anywhere;font-size:12px">
        ${error}
      </div>`}
    <//>
  `
}
