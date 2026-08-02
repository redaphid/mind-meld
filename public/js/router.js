// Hash routing: no server-side rewrite needed, so the same static files work
// behind the tunnel, from a home screen shortcut, and from file:// debugging.
//
//   #/search?q=chroma   →  { path: ['search'], query: { q: 'chroma' } }

import { useState, useEffect } from 'preact'

const parse = () => {
  const raw = location.hash.replace(/^#\/?/, '')
  const [pathPart, queryPart] = raw.split('?')
  return {
    path: pathPart.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
  }
}

export const navigate = (path, query = {}) => {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString()
  location.hash = `#/${path}${qs ? `?${qs}` : ''}`
}

// Replaces rather than pushes: used for live-editing a filter, so the Back
// button still leaves the view instead of walking every keystroke.
export const replaceQuery = (path, query = {}) => {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString()
  history.replaceState(null, '', `#/${path}${qs ? `?${qs}` : ''}`)
}

export const useRoute = () => {
  const [route, setRoute] = useState(parse)

  useEffect(() => {
    const onChange = () => setRoute(parse())
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])

  return route
}
