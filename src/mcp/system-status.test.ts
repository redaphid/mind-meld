import { describe, it, expect, vi } from 'vitest'

// These are the pure mappers, but importing the module pulls in the Chroma
// client behind them. Stubbed so this file does not drag a real client (and its
// whole surface) into the run just to test a snake_case-to-camelCase mapping.
vi.mock('../db/chroma.js', () => ({ getCollectionStats: vi.fn() }))

const { parseGate, toResidentModels, GATE_ABSENT, readCpu } = await import('./system-status.js')

// A real holding response, as the proxy actually sends it.
const HOLDING = {
  open: false,
  gpu_in_use_now: true,
  quiet_seconds: 6,
  required_quiet_seconds: 900,
  hold_reason: 'gpu_busy',
  other_vram_mb: 9566,
  busy_threshold_mb: 4000,
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
      otherVramMb: 9566,
      busyThresholdMb: 4000,
      status: 'GPU is in use by other applications right now.',
    })
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
