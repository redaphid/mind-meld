// The bottom rung of disclosure: raw messages, for a whole session or for one
// span of it. Shared by the session reader and by the inline drill-down in a
// result row, so "reading messages" behaves the same wherever you got there.

import { html, useState, useEffect, useCallback } from 'preact'
import { apiGet } from './api.js'
import { Spinner, ErrorBox, Empty, Pill } from './ui.js'
import { fmtNum, fmtExact, fmtDateTime } from './util.js'

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

// range: { start, end } message ids, or null for the session from the top.
// onExitRange is optional — only the full-page reader has somewhere to go back
// to; an inline drill-down is already surrounded by its own context.
export const MessageReader = ({ sessionId, range, onExitRange }) => {
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
    onExitRange &&
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
