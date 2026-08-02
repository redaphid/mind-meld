// Small presentational pieces shared across views.

import { html } from 'preact'
import { timeAgo, fmtNum, fmtExact, sourceLabel, highlight, pct } from './util.js'
import { navigate } from './router.js'

export const Spinner = ({ label = 'Loading…' }) =>
  html`<div class="loading"><span class="spinner"></span><span>${label}</span></div>`

export const ErrorBox = ({ error, onRetry }) =>
  html`<div class="err">
    <strong>Couldn't load that.</strong>
    <div class="mono" style="margin-top:6px">${error}</div>
    ${onRetry &&
    html`<button class="btn sm" style="margin-top:10px" onClick=${onRetry}>Try again</button>`}
  </div>`

export const Empty = ({ children }) => html`<div class="empty">${children}</div>`

export const Card = ({ title, action, children }) => html`
  <section class="card">
    ${title &&
    html`<h2>
      ${title}${action && html`<span class="right" style="text-transform:none">${action}</span>`}
    </h2>`}
    ${children}
  </section>
`

export const Stat = ({ n, label, sub, exact }) => html`
  <div class="stat">
    <span class="n" title=${exact ?? fmtExact(n)}>${typeof n === 'number' ? fmtNum(n) : n}</span>
    <span class="l">${label}</span>
    ${sub && html`<div class="sub">${sub}</div>`}
  </div>
`

export const Pill = ({ kind, children, title }) =>
  html`<span class="pill ${kind ?? ''}" title=${title}>${children}</span>`

// One search hit or session listing. Both render the same shape so scanning a
// result list and a browse list feels identical.
export const SessionRow = ({ session, snippet, tier, score, onClick }) => html`
  <button class="row" onClick=${onClick ?? (() => navigate(`session/${session.id ?? session.sessionId}`))}>
    <div class="t">${session.title ?? 'Untitled session'}</div>
    <div class="m">
      <span>${session.project ?? 'unknown project'}</span>
      <${Pill}>${sourceLabel(session.source)}<//>
      ${session.messageCount != null && html`<span>${fmtNum(session.messageCount)} msgs</span>`}
      ${tier && html`<${Pill} kind=${`tier-${tier}`}>${tier} match<//>`}
      ${score != null && html`<span class="faint mono">${score.toFixed(3)}</span>`}
      <span class="right faint nowrap">${timeAgo(session.startedAt ?? session.date) ?? '—'}</span>
    </div>
    ${snippet && html`<div class="s">${highlight(snippet)}</div>`}
  </button>
`

export const Bar = ({ value, total, tone }) => html`
  <div class="bar"><i style=${`width:${pct(value, total)}%${tone ? `;background:${tone}` : ''}`}></i></div>
`
