// App shell: tab bar, routing, and the health dot in the title bar.

import { html, render, useState, useEffect } from 'preact'
import { useRoute, navigate } from './router.js'
import { useApi } from './api.js'
import { OverviewView } from './views/overview.js'
import { SearchView } from './views/search.js'
import { BrowseView } from './views/browse.js'
import { SessionView } from './views/session.js'
import { LogsView } from './views/logs.js'
import { QuarantineView } from './views/quarantine.js'

const icon = d =>
  html`<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`

const ICONS = {
  overview: icon(html`<path d="M3 13h5v8H3zM10 3h4v18h-4zM16 9h5v12h-5z" />`),
  search: icon(html`<circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />`),
  browse: icon(html`<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />`),
  logs: icon(html`<path d="M4 6h16M4 12h16M4 18h10" />`),
}

const TABS = [
  ['overview', 'Status'],
  ['search', 'Search'],
  ['browse', 'Browse'],
  ['logs', 'Logs'],
]

// A stale index is the failure you actually care about: the server answers, but
// nothing has been synced for hours.
const healthClass = status => {
  if (!status) return 'down'
  const latest = status.latestSession?.startedAt
  if (!latest) return 'stale'
  const hours = (Date.now() - new Date(latest).getTime()) / 3_600_000
  return hours > 24 ? 'stale' : ''
}

const TITLES = {
  overview: 'Mindmeld',
  search: 'Search',
  browse: 'Browse',
  logs: 'Logs',
  session: 'Session',
  quarantine: 'Quarantine',
}

const App = () => {
  const route = useRoute()
  const view = route.path[0] ?? 'overview'
  const status = useApi('/status')
  const [installEvent, setInstallEvent] = useState(null)

  useEffect(() => {
    if (!location.hash) navigate('overview')
  }, [])

  useEffect(() => {
    const onPrompt = e => {
      e.preventDefault()
      setInstallEvent(e)
    }
    addEventListener('beforeinstallprompt', onPrompt)
    return () => removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  const body =
    view === 'session'
      ? html`<${SessionView} id=${route.path[1]} />`
      : view === 'search'
        ? html`<${SearchView} />`
        : view === 'browse'
          ? html`<${BrowseView} />`
          : view === 'logs'
            ? html`<${LogsView} />`
            : view === 'quarantine'
              ? html`<${QuarantineView} />`
              : html`<${OverviewView} />`

  return html`
    <div class="shell">
      <nav class="tabs">
        ${TABS.map(
          ([id, label]) => html`
            <button
              key=${id}
              class=${view === id ? 'active' : ''}
              onClick=${() => navigate(id)}
              aria-current=${view === id ? 'page' : undefined}
            >
              ${ICONS[id]}<span>${label}</span>
            </button>
          `
        )}
      </nav>
      <div class="col">
        <header class="topbar">
          <span
            class=${`brand-dot ${healthClass(status.data)}`}
            title=${status.error ? `unreachable: ${status.error}` : 'index healthy'}
          ></span>
          <h1>${TITLES[view] ?? 'Mindmeld'}</h1>
          ${installEvent &&
          html`<button
            class="btn sm"
            onClick=${async () => {
              installEvent.prompt()
              setInstallEvent(null)
            }}
          >
            Install
          </button>`}
        </header>
        <main>${body}</main>
      </div>
    </div>
  `
}

render(html`<${App} />`, document.getElementById('app'))

if ('serviceWorker' in navigator)
  addEventListener('load', () =>
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW failed', err))
  )
