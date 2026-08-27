// Progressive disclosure, in place. One row, four rungs — the same ladder the
// MCP tools climb (search → getSession → getMessages), except you walk it
// without leaving the list:
//
//   0  title                     what search/browse hands back
//   1  summary + why it matched  the session digest
//   2  section summaries         the chunk manifest
//   3  the messages themselves   one span at a time
//
// Nothing below rung 0 is fetched until it is asked for, and a rung that has
// been opened once keeps its data, so collapsing costs nothing to undo.

import { html, useState } from 'preact'
import { useApi } from './api.js'
import { navigate } from './router.js'
import { Spinner, ErrorBox, Pill } from './ui.js'
import { MessageReader } from './messages.js'
import { fmtNum, timeAgo, sourceLabel, highlight } from './util.js'

// Rung 3 under a section: the section's own span of messages.
const Section = ({ sessionId, chunk, open, matched, onToggle }) => html`
  <div class="chunk ${open ? 'open' : ''} ${matched ? 'matched' : ''}">
    <button class="chunk-head" aria-expanded=${open} onClick=${onToggle}>
      <span class="caret">▸</span>
      <span class="idx"
        >[${chunk.index}] msgs ${chunk.startMessageId}–${chunk.endMessageId} ·
        ${fmtNum(chunk.chars)} chars</span
      >
      ${matched && html`<${Pill} kind="tier-chunk">matched<//>`}
    </button>
    <div class="chunk-sum ${open || matched ? '' : 'clamp2'}">${chunk.summary}</div>
    ${open &&
    html`<div class="rung">
      <${MessageReader}
        sessionId=${sessionId}
        range=${{ start: chunk.startMessageId, end: chunk.endMessageId }}
      />
    </div>`}
  </div>
`

// session: a search hit or a session list item — both carry an id, a title and
// enough metadata for rung 1, and differ only in which key holds the id.
export const DisclosureRow = ({ session, snippet, tier, score, cursor }) => {
  const id = session.id ?? session.sessionId
  const [open, setOpen] = useState(false)
  const [everOpen, setEverOpen] = useState(false)
  const [sections, setSections] = useState(false)
  const [chunk, setChunk] = useState(null)
  const [matchedMessage, setMatchedMessage] = useState(null)
  const [wholeSummary, setWholeSummary] = useState(false)

  const { data, error, loading, reload } = useApi(everOpen ? `/api/sessions/${id}` : null)
  const digest = data?.digest

  // Opening a hit reveals the region that matched, one rung deeper than a plain
  // session hit — a chunk hit opens the section list with its section marked,
  // a message hit shows that message. Neither skips ahead to the whole span:
  // the point of the ladder is that you choose the next rung.
  const expand = () => {
    setEverOpen(true)
    setOpen(true)
    if (cursor?.chunkIndex != null) setSections(true)
    if (cursor?.messageId != null) setMatchedMessage(cursor.messageId)
  }

  const deepLink = cursor?.messageId
    ? { msg: cursor.messageId }
    : cursor?.chunkIndex != null
      ? { chunk: cursor.chunkIndex }
      : {}

  return html`
    <div class="row disc ${open ? 'open' : ''}">
      <button
        class="disc-head"
        aria-expanded=${open}
        onClick=${() => (open ? setOpen(false) : expand())}
      >
        <span class="caret">▸</span>
        <span class="t ${session.title ? '' : 'faint'}">
          ${session.title ?? `Session ${id} — no title yet`}
        </span>
        <span class="right faint nowrap">${timeAgo(session.startedAt ?? session.date) ?? '—'}</span>
      </button>

      ${open &&
      html`
        <div class="disc-body">
          <div class="m">
            <span>${session.project ?? 'unknown project'}</span>
            <${Pill}>${sourceLabel(session.source)}<//>
            ${(digest?.messageCount ?? session.messageCount) != null &&
            html`<span>${fmtNum(digest?.messageCount ?? session.messageCount)} msgs</span>`}
            ${tier && html`<${Pill} kind=${`tier-${tier}`}>${tier} match<//>`}
            ${score != null && html`<span class="faint mono">${score.toFixed(3)}</span>`}
            <span class="right faint mono">#${id}</span>
          </div>

          ${snippet && html`<div class="s">${highlight(snippet)}</div>`}
          ${loading && !digest && html`<${Spinner} label="Loading summary…" />`}
          ${error && html`<${ErrorBox} error=${error} onRetry=${reload} />`}
          ${digest &&
          html`
            <!-- A session summary runs to paragraphs, so it gets a rung of its
                 own: a few lines here, the rest on a tap. Clamping is display
                 only — the whole text is in the DOM and stays findable. -->
            <button
              class="disc-sum ${wholeSummary ? '' : 'clamp6'}"
              aria-expanded=${wholeSummary}
              onClick=${() => setWholeSummary(s => !s)}
            >
              ${digest.summary ??
              digest.excerpt ??
              html`<span class="faint">Nothing summarised for this session yet.</span>`}
            </button>

            ${matchedMessage != null &&
            html`<div class="rung">
              <div class="rung-label">Matched message</div>
              <${MessageReader}
                sessionId=${id}
                range=${{ start: matchedMessage, end: matchedMessage }}
              />
            </div>`}

            <div class="disc-actions">
              ${digest.totalChunks > 0 &&
              html`<button class="btn sm" onClick=${() => setSections(s => !s)}>
                ${sections ? 'Hide' : 'Show'} ${digest.totalChunks} section${
                  digest.totalChunks === 1 ? '' : 's'
                }
              </button>`}
              <button class="btn sm" onClick=${() => navigate(`session/${id}`, deepLink)}>
                Open session →
              </button>
            </div>

            ${sections &&
            html`<div class="rung">
              ${digest.chunks.map(
                c => html`<${Section}
                  key=${c.index}
                  sessionId=${id}
                  chunk=${c}
                  open=${chunk === c.index}
                  matched=${cursor?.chunkIndex === c.index}
                  onToggle=${() => setChunk(chunk === c.index ? null : c.index)}
                />`
              )}
              ${digest.chunks.length < digest.totalChunks &&
              html`<div class="faint" style="font-size:12px;padding:4px 2px">
                Showing ${digest.chunks.length} of ${digest.totalChunks} sections —
                open the session for the rest.
              </div>`}
            </div>`}
          `}
        </div>
      `}
    </div>
  `
}

// The ladder is invisible until you climb it, so the list says so once, at the
// top, rather than decorating every row with a hint.
export const DisclosureHint = () => html`
  <div class="disc-hint">
    Tap a title to open its summary, then its sections, then the messages.
  </div>
`
