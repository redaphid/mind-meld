// Service worker: makes the UI installable and readable offline.
//
// Shell assets are precached and served cache-first (they change only on
// deploy). API reads are network-first with a cache fallback, so a phone that
// drops off the tunnel still shows the last state it saw instead of an error
// page. Nothing that mutates — /mcp, /api/ingest — is ever cached.

const VERSION = 'v9'
const SHELL_CACHE = `mindmeld-shell-${VERSION}`
const DATA_CACHE = `mindmeld-data-${VERSION}`

const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/manifest.webmanifest',
  '/vendor/preact.js',
  '/js/app.js',
  '/js/api.js',
  '/js/router.js',
  '/js/ui.js',
  '/js/util.js',
  '/js/views/overview.js',
  '/js/views/search.js',
  '/js/views/browse.js',
  '/js/views/session.js',
  '/js/views/logs.js',
  '/js/views/quarantine.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, so one 404 can't abort the whole install.
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k.startsWith('mindmeld-') && k !== SHELL_CACHE && k !== DATA_CACHE)
            .map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  )
})

const isData = url =>
  url.pathname.startsWith('/api/') || url.pathname === '/status' || url.pathname === '/logs'

const networkFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    if (request.mode === 'navigate') {
      const shell = await caches.match('/index.html')
      if (shell) return shell
    }
    return new Response(
      JSON.stringify({ status: 'error', error: 'offline — no cached copy of this view' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )
  }
}

const cacheFirst = async request => {
  const cached = await caches.match(request)
  if (cached) {
    // Refresh in the background so the next load is current.
    fetch(request)
      .then(res => res.ok && caches.open(SHELL_CACHE).then(c => c.put(request, res)))
      .catch(() => {})
    return cached
  }
  return fetch(request)
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== location.origin) return
  if (url.pathname === '/mcp') return

  if (isData(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE))
    return
  }

  // The shell itself is revalidated on every load: a stale index.html would pin
  // the app to an API contract the server may no longer speak.
  if (request.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request, SHELL_CACHE))
    return
  }

  event.respondWith(cacheFirst(request))
})
