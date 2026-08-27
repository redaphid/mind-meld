import { describe, it, expect, vi } from 'vitest'

// These are the pure mappers, but importing the module pulls in the Chroma
// client behind them. Stubbed so this file does not drag a real client (and its
// whole surface) into the run just to test a snake_case-to-camelCase mapping.
vi.mock('../db/chroma.js', () => ({ getCollectionStats: vi.fn() }))

const { parseGate, toResidentModels, GATE_ABSENT, readCpu } = await import('./system-status.js')

// A holding response in the exact shape ollama-proxy's GET /_gate returns.
//
// This fixture previously claimed to be "as the proxy actually sends it" while
// carrying `other_vram_mb` / `busy_threshold_mb`, keys the proxy has never
// emitted. Because parseGate maps every field with `?? null`, the mismatch
// could not throw — it just resolved both to null, and the GPU panel rendered
// blank forever while this test passed. The load signal is GPU *utilization*
// percent, summed across engines, so it can exceed 100.
const HOLDING = {
  open: false,
  gpu_in_use_now: true,
  quiet_seconds: 6,
  required_quiet_seconds: 900,
  hold_reason: 'gpu_busy',
  other_util_pct: 96.4,
  busy_threshold_pct: 10,
  status: 'GPU is in use by other applications right now.',
}

describe('parseGate', () => {
  it('carries every field across the snake_case boundary', () => {
    expect(parseGate(HOLDING)).toEqual({
      present: true,
      open: false,
      gpuInUseNow: true,
      quietSeconds: 6,
      requiredQuietSeconds: 900,
      holdReason: 'gpu_busy',
      otherUtilPct: 96.4,
      busyThresholdPct: 10,
      status: 'GPU is in use by other applications right now.',
    })
  })

  // The regression that left the GPU panel blank: the consumer read MB-named
  // keys the proxy does not send. Reading a percentage the proxy DOES send is
  // the contract, and a null here means the panel has nothing to draw.
  it('reads the utilization keys the proxy emits, not VRAM ones', () => {
    expect(parseGate(HOLDING).otherUtilPct).toBe(96.4)
    expect(parseGate({ other_vram_mb: 9566, busy_threshold_mb: 4000 }).otherUtilPct).toBeNull()
  })

  // Summed across every engine of every non-Ollama process, so >100 is real
  // and must survive rather than being clamped or rejected.
  it('keeps a utilization figure above 100 intact', () => {
    expect(parseGate({ ...HOLDING, other_util_pct: 147.2 }).otherUtilPct).toBe(147.2)
  })

  it('passes the proxy status sentence through whole', () => {
    const long = 'x'.repeat(400)
    expect(parseGate({ ...HOLDING, status: long }).status).toBe(long)
  })

  // A proxy version that stops sending a field must degrade that one field,
  // not throw and take the whole /api/system response down with it.
  it('degrades unknown-shaped payloads to nulls rather than throwing', () => {
    expect(parseGate({})).toEqual({ ...GATE_ABSENT, present: true })
    expect(parseGate(null)).toEqual({ ...GATE_ABSENT, present: true })
  })

  // `open: false` is meaningful and must survive the ?? chain that would turn a
  // falsy value into null.
  it('keeps a false apart from a missing field', () => {
    expect(parseGate({ open: false }).open).toBe(false)
    expect(parseGate({}).open).toBeNull()
  })
})

describe('toResidentModels', () => {
  const configured = { embedding: 'bge-m3', summarize: 'qwen3:4b-instruct' }

  it('matches our models regardless of tag on either side', () => {
    const models = toResidentModels(
      [
        { name: 'bge-m3:latest', size_vram: 664000265 },
        { name: 'qwen3:4b-instruct', size_vram: 5098103111 },
      ],
      configured
    )
    expect(models.map(m => m.ours)).toEqual([true, true])
  })

  // The signal that someone else is competing for the card.
  it('flags a model nobody here configured as not ours', () => {
    const [model] = toResidentModels([{ name: 'llama3:70b', size_vram: 40_000_000_000 }], configured)
    expect(model.ours).toBe(false)
    expect(model.sizeVramBytes).toBe(40_000_000_000)
  })

  it('survives an empty or absent model list', () => {
    expect(toResidentModels([], configured)).toEqual([])
    expect(toResidentModels(undefined as any, configured)).toEqual([])
  })

  it('defaults missing VRAM to zero so the total never becomes NaN', () => {
    const models = toResidentModels([{ name: 'bge-m3' }], configured)
    expect(models[0].sizeVramBytes).toBe(0)
    expect(models.reduce((s, m) => s + m.sizeVramBytes, 0)).toBe(0)
  })
})

describe('readCpu', () => {
  it('reports load as a share of cores, which is the only comparable form', () => {
    const cpu = readCpu()
    expect(cpu.cores).toBeGreaterThan(0)
    expect(cpu.loadPerCore).toBeCloseTo(cpu.load1 / cpu.cores, 1)
    expect(Number.isFinite(cpu.loadPerCore)).toBe(true)
  })
})
