// Thin fetch layer over the mindmeld REST surface, plus the hook every view
// uses to load into. Errors surface as messages, never as a blank screen.

import { useState, useEffect, useCallback, useRef } from 'preact'

const buildUrl = (path, params = {}) => {
  const url = new URL(path, location.origin)
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '' && v !== false) url.searchParams.set(k, v)
  return url.pathname + url.search
}

export const apiGet = async (path, params, signal) => {
  const res = await fetch(buildUrl(path, params), {
    signal,
    headers: { accept: 'application/json' },
  })
  const text = await res.text()

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
  }

  if (!res.ok || body.status === 'error')
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)

  return body
}

// Writes: POST/DELETE against the same surface.
//
// Unlike apiGet this does not treat a non-2xx status as failure by itself. The
// mutating routes answer 409 for states that are perfectly normal and carry
// exactly the information the caller needs — "a run is already in flight",
// "ingestion is standing down" — and each of those bodies is `status: 'ok'`. So
// the body's own verdict decides, and only an explicit error (or a response
// that is not JSON at all) throws.
export const apiSend = async (path, method = 'POST', body) => {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
  }

  if (parsed.status === 'error') throw new Error(parsed.error ?? `${res.status} ${res.statusText}`)
  return parsed
}

// key: any serialisable value. Changing it refetches; a null key means "not
// ready yet", which keeps a view from firing a request with missing params.
export const useApi = (path, params, key) => {
  const [state, setState] = useState({ data: null, error: null, loading: !!path })
  const [nonce, setNonce] = useState(0)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const serialised = JSON.stringify([path, key ?? params])

  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false })
      return
    }
    const controller = new AbortController()
    setState(s => ({ ...s, loading: true, error: null }))

    apiGet(path, paramsRef.current, controller.signal)
      .then(data => setState({ data, error: null, loading: false }))
      .catch(err => {
        if (err.name === 'AbortError') return
        // Keep whatever was last loaded. Views poll now, so a single failed
        // refresh must not blank a screen that was working a second ago — the
        // same reason the service worker serves a cached view when the tunnel
        // drops. A view with no data yet still gets data: null and renders its
        // error, because there is nothing else it could show.
        setState(s => ({ data: s.data, error: err.message, loading: false }))
      })

    return () => controller.abort()
  }, [serialised, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { ...state, reload }
}
