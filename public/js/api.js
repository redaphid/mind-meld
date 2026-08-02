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
        setState({ data: null, error: err.message, loading: false })
      })

    return () => controller.abort()
  }, [serialised, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { ...state, reload }
}
