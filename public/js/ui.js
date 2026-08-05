// Small presentational pieces shared across views.

import { html } from 'preact'
import { fmtNum, fmtExact, pct } from './util.js'

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

export const Bar = ({ value, total, tone }) => html`
  <div class="bar"><i style=${`width:${pct(value, total)}%${tone ? `;background:${tone}` : ''}`}></i></div>
`
