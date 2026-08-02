// Session reader — digest first (summary + chunk manifest), raw messages on
// demand. A chunk is a summary of a span of messages, so tapping one opens
// exactly that span rather than dumping the thread.

import { html, useState, useEffect, useCallback } from 'preact'
import { apiGet, useApi } from '../api.js'
import { useRoute, navigate } from '../router.js'
import { Card, Spinner, ErrorBox, Empty, Pill } from '../ui.js'
import { fmtNum, fmtExact, fmtDate, fmtDateTime, timeAgo } from '../util.js'

const PAGE = 15

const Message = ({ message, onExpand }) => html`
  <article class="msg ${message.role}">
    <header>
      <span class="role">${message.role}</span>
      ${message.toolName && html`<${Pill}>${message.toolName}<//>`}
      ${message.model && html`<span class="faint mono">${message.model}</span>`}
      <span class="right faint nowrap">
        ${message.truncated ? `${fmtNum(message.chars)} chars` : fmtDateTime(message.timestamp)}
      </span>
    </header>
    ${message.text
      ? html`<pre>${message.text}</pre>`
      : html`<pre class="faint">${
          message.toolName ? `(${message.toolName} call — no text captured)` : '(no text)'
        }</pre>`}
    ${message.truncated &&
    html`<div style="padding:0 12px 12px">
      <button class="btn sm" onClick=${() => onExpand(message.id)}>
        Load all ${fmtExact(message.chars)} characters
      </button>
    </div>`}
  </article>
`

const MessageReader = ({ sessionId, range, onExitRange }) => {
  const [messages, setMessages] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(
    async (params, append) => {
      setLoading(true)
      setError(null)
      try {
        const data = await apiGet(`/api/sessions/${sessionId}/messages`, params)
        setMessages(prev => (append ? [...prev, ...data.messages] : data.messages))
        setNext(
          data.nextOffset != null
            ? { offset: data.nextOffset, limit: PAGE }
            : data.nextStartMessageId != null
              ? { startMessageId: data.nextStartMessageId, endMessageId: range?.end }
              : null
        )
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    },
    [sessionId, range?.end]
  )

  const initial = () =>
    range ? { startMessageId: range.start, endMessageId: range.end } : { offset: 0, limit: PAGE }

  useEffect(() => {
    setMessages([])
    load(initial(), false)
  }, [sessionId, range?.start, range?.end])

  // Swaps a truncated stub for the whole message, in place.
  const expand = async id => {
    const { message } = await apiGet(`/api/messages/${id}`)
    setMessages(prev => prev.map(m => (m.id === id ? message : m)))
  }

  return html`
    ${range &&
    html`<div class="backbar">
      <button class="btn sm" onClick=${onExitRange}>← Whole session</button>
      <span class="faint mono right">msgs ${range.start}–${range.end}</span>
    </div>`}
    ${error && html`<${ErrorBox} error=${error} onRetry=${() => load(initial(), false)} />`}
    ${messages.map(m => html`<${Message} key=${m.id} message=${m} onExpand=${expand} />`)}
    ${loading && html`<${Spinner} label="Reading messages…" />`}
    ${!loading && messages.length === 0 && html`<${Empty}>No messages in this range.<//>`}
    ${!loading &&
    next &&
    html`<div class="pager">
      <button class="btn" style="width:100%" onClick=${() => load({ ...next, limit: PAGE }, true)}>
        Load more
      </button>
    </div>`}
  `
}

export const SessionView = ({ id }) => {
  const { query } = useRoute()
  const [tab, setTab] = useState('digest')
  const [range, setRange] = useState(null)
  const { data, error, loading, reload } = useApi(`/api/sessions/${id}`)

  const digest = data?.digest

  // A search hit carrying a cursor lands you on the matched region, not the top.
  useEffect(() => {
    if (!digest) return
    if (query.chunk != null) {
      const chunk = digest.chunks.find(c => String(c.index) === String(query.chunk))
      if (chunk) {
        setRange({ start: chunk.startMessageId, end: chunk.endMessageId })
        setTab('messages')
      }
    } else if (query.msg) {
      setRange({ start: Number(query.msg), end: Number(query.msg) })
      setTab('messages')
    }
  }, [digest, query.chunk, query.msg])

  if (loading && !data) return html`<${Spinner} label="Loading session…" />`
  if (error) return html`<${ErrorBox} error=${error} onRetry=${reload} />`

  return html`
    <div class="backbar">
      <button class="btn sm" onClick=${() => history.back()}>← Back</button>
      <span class="right faint mono">#${digest.sessionId}</span>
    </div>

    <h2 class="session-title" title=${digest.title ?? ''}>
      ${digest.title ?? html`<span class="faint">Session ${digest.sessionId} — no title yet</span>`}
    </h2>
    <div class="m" style="margin-bottom:14px;font-size:13px;color:var(--muted)">
      <button
        class="pill"
        style="cursor:pointer"
        onClick=${() => navigate('browse', { project: digest.projectId })}
      >
        ${digest.project}
      </button>
      <span>${fmtDate(digest.date)}</span>
      <span>${fmtNum(digest.messageCount)} messages</span>
      ${digest.tokens > 0 && html`<span>${fmtNum(digest.tokens)} tokens</span>`}
      <span class="right faint nowrap">${timeAgo(digest.date)}</span>
    </div>

    <div class="seg" style="margin-bottom:12px">
      <button class=${tab === 'digest' ? 'on' : ''} onClick=${() => setTab('digest')}>
        Summary${digest.totalChunks ? ` · ${digest.totalChunks}` : ''}
      </button>
      <button
        class=${tab === 'messages' ? 'on' : ''}
        onClick=${() => {
          setRange(null)
          setTab('messages')
        }}
      >
        Messages
      </button>
    </div>

    ${tab === 'digest' &&
    html`
      <${Card} title=${digest.summary ? 'Summary' : 'Excerpt (no summary yet)'}>
        <div style="white-space:pre-wrap;overflow-wrap:anywhere">
          ${digest.summary ?? digest.excerpt ?? 'Nothing summarised for this session yet.'}
        </div>
      <//>
      ${digest.chunks.length > 0 &&
      html`<${Card} title=${`Chunks (${digest.chunks.length} of ${digest.totalChunks})`}>
        ${digest.chunks.map(
          c => html`
            <div class="chunk" key=${c.index}>
              <div class="idx">
                [${c.index}] msgs ${c.startMessageId}–${c.endMessageId} · ${fmtNum(c.chars)} chars
              </div>
              <div style="font-size:14px;margin:4px 0 6px;overflow-wrap:anywhere">${c.summary}</div>
              <button
                class="btn sm"
                onClick=${() => {
                  setRange({ start: c.startMessageId, end: c.endMessageId })
                  setTab('messages')
                }}
              >
                Read this span
              </button>
            </div>
          `
        )}
      <//>`}
    `}
    ${tab === 'messages' &&
    html`<${MessageReader}
      sessionId=${digest.sessionId}
      range=${range}
      onExitRange=${() => setRange(null)}
    />`}
  `
}
