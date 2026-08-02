// Quarantine — records sync could not process, kept whole instead of dropped.
// A non-zero count means data is waiting, not that data was lost.

import { html, useState } from 'preact'
import { apiGet, useApi } from '../api.js'
import { Card, Spinner, ErrorBox, Empty, Pill } from '../ui.js'
import { fmtNum, fmtDateTime, timeAgo, shortPath } from '../util.js'

const retry = async id => {
  const res = await fetch(`/api/quarantine/retry${id ? `?id=${id}` : ''}`, { method: 'POST' })
  const body = await res.json()
  if (body.status === 'error') throw new Error(body.error)
  return body
}

const Record = ({ record, onRetried, onError }) => {
  const [busy, setBusy] = useState(false)
  const [payload, setPayload] = useState(null)

  const showPayload = async () => {
    const { records } = await apiGet('/api/quarantine', {
      withPayload: true,
      includeResolved: true,
      limit: 200,
    })
    setPayload(records.find(r => r.id === record.id)?.payload ?? '(payload unavailable)')
  }

  return html`
    <div class="card" style="margin-bottom:8px">
      <div class="m" style="margin:0">
        <${Pill} kind=${record.stage === 'parse' ? 'warn' : 'bad'}>${record.stage}<//>
        ${record.resolvedAt
          ? html`<${Pill} kind="good">recovered<//>`
          : html`<span class="faint">${record.attempts} attempt${record.attempts === 1 ? '' : 's'}</span>`}
        <span class="faint">${record.machine ?? 'unknown machine'}</span>
        <span class="right faint nowrap">${timeAgo(record.lastAttemptAt)}</span>
      </div>

      <div class="mono" style="margin-top:8px;color:var(--red);overflow-wrap:anywhere">
        ${record.error}
      </div>

      <div class="mono faint" style="margin-top:6px;overflow-wrap:anywhere">
        ${shortPath(record.filePath)}${record.lineNumber ? `:${record.lineNumber}` : ''}
        ${record.sessionId ? ` · session ${record.sessionId}` : ' · no session yet'}
      </div>

      ${payload &&
      html`<pre
        class="mono"
        style="margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto"
      >
${payload}</pre
      >`}

      <div class="m" style="margin-top:10px">
        <button class="btn sm" onClick=${showPayload} disabled=${!!payload}>Show record</button>
        ${!record.resolvedAt &&
        html`<button
          class="btn sm"
          disabled=${busy}
          onClick=${async () => {
            setBusy(true)
            try {
              await retry(record.id)
              onRetried()
            } catch (e) {
              onError(e.message)
            } finally {
              setBusy(false)
            }
          }}
        >
          ${busy ? 'Retrying…' : 'Retry'}
        </button>`}
      </div>
    </div>
  `
}

export const QuarantineView = () => {
  const [includeResolved, setIncludeResolved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const params = { limit: 50, includeResolved: includeResolved ? '1' : '' }
  const { data, error, loading, reload } = useApi('/api/quarantine', params, params)

  const retryAll = async () => {
    setBusy(true)
    setNote(null)
    try {
      const result = await retry()
      setNote(
        result.attempted === 0
          ? 'Nothing pending.'
          : `Recovered ${result.recovered} of ${result.attempted}.`
      )
      reload()
    } catch (e) {
      setNote(e.message)
    } finally {
      setBusy(false)
    }
  }

  return html`
    <${Card} title="What this is">
      <div style="font-size:14px;color:var(--muted)">
        Records sync could not parse or insert. Each one is kept whole — the raw
        bytes, base64-encoded so nothing in them can break the copy — with enough
        context to put it back. Retrying is safe: a record that fails again keeps
        its row and its error.
      </div>
    <//>

    <div class="filters">
      <button class="btn" disabled=${busy || !(data?.pending > 0)} onClick=${retryAll}>
        ${busy ? 'Retrying…' : `Retry all${data?.pending ? ` (${data.pending})` : ''}`}
      </button>
      <label class="check">
        <input
          type="checkbox"
          checked=${includeResolved}
          onChange=${e => setIncludeResolved(e.target.checked)}
        />
        show recovered
      </label>
    </div>

    ${note && html`<div class="toast" style="position:static;text-align:center">${note}</div>`}
    ${loading && !data && html`<${Spinner} label="Loading quarantine…" />`}
    ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
    ${data &&
    html`
      <div class="faint" style="font-size:13px;margin:10px 2px">
        ${fmtNum(data.pending)} pending${includeResolved ? ` · ${data.total} total shown` : ''}
      </div>
      ${data.records.length === 0
        ? html`<${Empty}>Nothing quarantined — every record sync saw went in.<//>`
        : data.records.map(
            r => html`<${Record} key=${r.id} record=${r} onRetried=${reload} onError=${setNote} />`
          )}
    `}
  `
}
