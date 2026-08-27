import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getCollectionStats = vi.fn()
vi.mock('../db/chroma.js', () => ({
  getCollectionStats: (...args: unknown[]) => getCollectionStats(...args),
}))

const { readSystemStatus } = await import('./system-status.js')

const json = (body: unknown, ok = true) => ({ ok, json: async () => body })

// The proxy answers /_gate, /api/version and /api/ps; Chroma is mocked
// separately. Routed by URL so a test can break one endpoint and leave the
// others working — which is the whole point of the per-probe degradation.
const routeFetch = (handlers: Record<string, () => unknown>) =>
  vi.fn(async (url: string) => {
    for (const [fragment, handler] of Object.entries(handlers))
      if (String(url).includes(fragment)) return handler() as any
    throw new Error(`unexpected fetch: ${url}`)
  })

const GATE_OPEN = { open: true, gpu_in_use_now: false, other_util_pct: 1.2, status: 'clear' }

beforeEach(() => {
  getCollectionStats.mockReset()
  getCollectionStats.mockImplementation(async (name: string) => ({ name, count: 5 }))
})
afterEach(() => vi.unstubAllGlobals())

describe('readSystemStatus', () => {
  it('reports a healthy gate, version and resident models together', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => json(GATE_OPEN),
        '/api/version': () => json({ version: '0.32.5' }),
        '/api/ps': () => json({ models: [{ name: 'bge-m3:latest', size_vram: 664000265 }] }),
      })
    )

    const s = await readSystemStatus()

    expect(s.ollama.reachable).toBe(true)
    expect(s.ollama.version).toBe('0.32.5')
    expect(s.ollama.gate.present).toBe(true)
    expect(s.ollama.gate.open).toBe(true)
    expect(s.ollama.vramBytesTotal).toBe(664000265)
    expect(s.ollama.models[0].ours).toBe(true)
  })

  // The state this whole panel exists for: the gate is fine and deliberately
  // holding work back. That must not read as a fault.
  it('keeps the gate readable while it is holding work back', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => json({ open: false, gpu_in_use_now: true, other_util_pct: 96.4 }),
        '/api/version': () => json({ version: '0.32.5' }),
        '/api/ps': () => json({ models: [] }),
      })
    )

    const s = await readSystemStatus()

    expect(s.ollama.reachable).toBe(true)
    expect(s.ollama.gate.open).toBe(false)
    expect(s.ollama.gate.gpuInUseNow).toBe(true)
    expect(s.ollama.gate.otherUtilPct).toBe(96.4)
    expect(s.ollama.error).toBeNull()
  })

  // Running against real Ollama instead of the proxy is a valid configuration,
  // just a less polite one. A 404 on /_gate means "no gate", not "broken".
  it('treats a missing /_gate as no gate rather than an error', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => json({}, false),
        '/api/version': () => json({ version: '0.32.5' }),
        '/api/ps': () => json({ models: [] }),
      })
    )

    const s = await readSystemStatus()

    expect(s.ollama.gate.present).toBe(false)
    expect(s.ollama.reachable).toBe(true)
    expect(s.ollama.error).toBeNull()
  })

  it('degrades to unreachable with the reason when Ollama refuses the connection', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => {
          throw new Error('ECONNREFUSED')
        },
        '/api/version': () => {
          throw new Error('connect ECONNREFUSED 192.168.65.254:11436')
        },
        '/api/ps': () => {
          throw new Error('ECONNREFUSED')
        },
      })
    )

    const s = await readSystemStatus()

    expect(s.ollama.reachable).toBe(false)
    expect(s.ollama.error).toContain('ECONNREFUSED')
    expect(s.ollama.models).toEqual([])
    expect(s.ollama.vramBytesTotal).toBe(0)
    // Still reports which URL failed — that is the fact that identifies the
    // proxy as the culprit rather than Docker.
    expect(s.ollama.url).toBeTruthy()
  })

  it('counts every configured collection when Chroma answers', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => json(GATE_OPEN),
        '/api/version': () => json({ version: '0.32.5' }),
        '/api/ps': () => json({ models: [] }),
      })
    )

    const s = await readSystemStatus()

    expect(s.chroma.reachable).toBe(true)
    expect(s.chroma.collections.map(c => c.name)).toContain('convo-messages')
    expect(s.chroma.latencyMs).toBeGreaterThanOrEqual(0)
  })

  // One dependency being down must not take the status response with it —
  // that is exactly when someone is looking at this screen.
  it('reports a dead Chroma without losing the Ollama reading', async () => {
    getCollectionStats.mockRejectedValue(new Error('chroma down'))
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => json(GATE_OPEN),
        '/api/version': () => json({ version: '0.32.5' }),
        '/api/ps': () => json({ models: [] }),
      })
    )

    const s = await readSystemStatus()

    expect(s.chroma.reachable).toBe(false)
    expect(s.chroma.error).toContain('chroma down')
    expect(s.chroma.collections).toEqual([])
    expect(s.ollama.reachable).toBe(true)
  })

  it('always carries CPU facts, which need no probe', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/_gate': () => json(GATE_OPEN),
        '/api/version': () => json({ version: '0.32.5' }),
        '/api/ps': () => json({ models: [] }),
      })
    )

    const s = await readSystemStatus()

    expect(s.cpu.cores).toBeGreaterThan(0)
    expect(typeof s.cpu.loadAvailable).toBe('boolean')
    expect(s.cpu.memory.totalBytes).toBeGreaterThan(0)
  })
})
