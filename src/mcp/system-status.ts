import os from 'os'
import { config } from '../config.js'
import { getCollectionStats } from '../db/chroma.js'

// What the dashboard needs to answer "why is nothing moving right now", for the
// three dependencies that can each stall the pipeline on their own: the Ollama
// gate, Chroma, and the GPU.
//
// Everything here is a *live probe*, so everything here can hang. Each one
// carries its own timeout and each one degrades to `reachable: false` with the
// reason attached — a status screen that throws because one dependency is down
// is useless at exactly the moment it is needed.

// Long enough for a loaded host to answer, short enough that a dead dependency
// does not hold the whole status response open.
const PROBE_TIMEOUT_MS = 4000

const withTimeout = async (url: string, ms = PROBE_TIMEOUT_MS): Promise<Response> => {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), ms)
  try {
    return await fetch(url, { signal: control.signal })
  } finally {
    clearTimeout(timer)
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// The GPU gate in front of Ollama — the "nice" proxy.
//
// OLLAMA_URL does not point at Ollama. It points at a small gating proxy that
// holds mindmeld's GPU work back while games, ComfyUI or another machine are
// using the card, and passes it through when they are not. That indirection is
// invisible from inside this repo (the proxy lives outside it), and its absence
// presents as ECONNREFUSED on every embed — which reads like a Docker fault and
// is not one. So the gate gets a first-class panel rather than a footnote.
//
// `/_gate` is the proxy's own endpoint and is what distinguishes the two states
// that matter and look identical from here: "the GPU is busy so I am holding
// your work" versus "I am broken". A plain Ollama on this URL simply 404s it,
// which is reported as `present: false` rather than as an error — running
// against real Ollama is a valid, if less polite, configuration.
export type GateStatus = {
  present: boolean
  open: boolean | null
  gpuInUseNow: boolean | null
  quietSeconds: number | null
  requiredQuietSeconds: number | null
  holdReason: string | null
  // VRAM held by processes that are not Ollama — i.e. what mindmeld is being
  // asked to yield to. This is the only real GPU-load signal available here:
  // no mindmeld container has GPU access, so nothing inside one can run
  // nvidia-smi. The proxy can, and already does.
  otherVramMb: number | null
  busyThresholdMb: number | null
  // The proxy's own full sentence explaining the current state. Passed through
  // whole — it is already written for a human, and truncating it would remove
  // the half that says what to do.
  status: string | null
}

export const GATE_ABSENT: GateStatus = {
  present: false,
  open: null,
  gpuInUseNow: null,
  quietSeconds: null,
  requiredQuietSeconds: null,
  holdReason: null,
  otherVramMb: null,
  busyThresholdMb: null,
  status: null,
}

// snake_case on the wire (the proxy is Python), camelCase in here. Every field
// is optional: a future proxy version that drops one should degrade that field
// to null, not throw and take the whole status response with it.
export const parseGate = (g: any): GateStatus => ({
  present: true,
  open: g?.open ?? null,
  gpuInUseNow: g?.gpu_in_use_now ?? null,
  quietSeconds: g?.quiet_seconds ?? null,
  requiredQuietSeconds: g?.required_quiet_seconds ?? null,
  holdReason: g?.hold_reason ?? null,
  otherVramMb: g?.other_vram_mb ?? null,
  busyThresholdMb: g?.busy_threshold_mb ?? null,
  status: g?.status ?? null,
})

const readGate = async (baseUrl: string): Promise<GateStatus> => {
  try {
    const res = await withTimeout(`${baseUrl}/_gate`)
    // A plain Ollama 404s this path. Not an error — just no gate.
    if (!res.ok) return GATE_ABSENT
    return parseGate(await res.json())
  } catch {
    return GATE_ABSENT
  }
}

export type ResidentModel = {
  name: string
  sizeVramBytes: number
  contextLength: number | null
  expiresAt: string | null
  // Whether this is one of the models mindmeld itself uses. A chat model
  // nobody here configured, sitting in VRAM, means another tenant is holding
  // the card — which is the difference between "we are slow" and "we are
  // queued behind someone else".
  ours: boolean
}

type OllamaStatus = {
  // Shown so "are we pointed at the nice proxy?" is answerable from the
  // screen. Internal container address, not a secret.
  url: string
  reachable: boolean
  version: string | null
  error: string | null
  gate: GateStatus
  models: ResidentModel[]
  vramBytesTotal: number
  // The models this deployment is configured to use, whether or not they are
  // currently resident.
  configured: { embedding: string; summarize: string }
}

// Ollama reports `name` as `qwen3:4b-instruct`; config may or may not carry the
// tag. Compared on the bare model name so `bge-m3` matches `bge-m3:latest`.
const bareName = (n: string) => n.split(':')[0]

// Which resident models are ours. Kept separate from the fetch so the rule that
// decides "someone else is holding the card" can be tested without a network.
export const toResidentModels = (
  psModels: any[],
  configured: { embedding: string; summarize: string }
): ResidentModel[] => {
  const ours = new Set([bareName(configured.embedding), bareName(configured.summarize)])
  return (psModels ?? []).map(m => ({
    name: m.name,
    sizeVramBytes: m.size_vram ?? 0,
    contextLength: m.context_length ?? null,
    expiresAt: m.expires_at ?? null,
    ours: ours.has(bareName(m.name ?? '')),
  }))
}

const readOllama = async (): Promise<OllamaStatus> => {
  const url = config.ollama.url
  const configured = {
    embedding: config.embeddings.model,
    summarize: config.embeddings.summarizeModel,
  }
  // The gate is probed even when Ollama itself answers nothing, because a shut
  // gate is the most likely reason it answered nothing.
  const gate = await readGate(url)

  try {
    const [versionRes, psRes] = await Promise.all([
      withTimeout(`${url}/api/version`),
      withTimeout(`${url}/api/ps`),
    ])

    const version = versionRes.ok ? ((await versionRes.json()) as any).version ?? null : null
    const ps: any = psRes.ok ? await psRes.json() : { models: [] }

    const models = toResidentModels(ps.models ?? [], configured)

    return {
      url,
      reachable: true,
      version,
      error: null,
      gate,
      models,
      vramBytesTotal: models.reduce((sum, m) => sum + m.sizeVramBytes, 0),
      configured,
    }
  } catch (e) {
    return {
      url,
      reachable: false,
      version: null,
      error: errorText(e),
      gate,
      models: [],
      vramBytesTotal: 0,
      configured,
    }
  }
}

type ChromaStatus = {
  url: string
  reachable: boolean
  error: string | null
  latencyMs: number | null
  collections: { name: string; count: number }[]
}

const readChroma = async (): Promise<ChromaStatus> => {
  const url = config.chroma.url
  const startedAt = Date.now()
  try {
    // Counting every configured collection doubles as the reachability probe:
    // a Chroma that answers a heartbeat but has lost its collections is broken
    // in a way a heartbeat alone would call healthy.
    const names = Object.values(config.chroma.collections)
    const collections = await Promise.all(names.map(name => getCollectionStats(name)))
    return { url, reachable: true, error: null, latencyMs: Date.now() - startedAt, collections }
  } catch (e) {
    return {
      url,
      reachable: false,
      error: errorText(e),
      latencyMs: Date.now() - startedAt,
      collections: [],
    }
  }
}

export type CpuStatus = {
  cores: number
  // os.loadavg() is hardcoded to [0,0,0] on Windows — there is no load average
  // to report. Served as a flag rather than as a zero, because "idle" and "this
  // platform does not measure it" are different answers and only one of them
  // should be drawn as an empty bar. The deployed server is Linux; this matters
  // when running it directly on a Windows host.
  loadAvailable: boolean
  // Unix load averages. On Docker Desktop this is the Linux VM's load, not the
  // Windows host's — it reflects what the containers are doing, which is the
  // question this screen is asking, but it is NOT whole-machine CPU. Labelled
  // as such in the UI rather than quietly presented as system load.
  load1: number
  load5: number
  load15: number
  // load1 as a share of cores, which is the only form of it that means the
  // same thing on a 4-core and a 32-core box.
  loadPerCore: number
  platform: string
  uptimeSeconds: number
  memory: { totalBytes: number; freeBytes: number }
}

export const readCpu = (): CpuStatus => {
  const [load1, load5, load15] = os.loadavg()
  const cores = os.cpus().length || 1
  return {
    cores,
    loadAvailable: os.platform() !== 'win32',
    load1,
    load5,
    load15,
    loadPerCore: Math.round((load1 / cores) * 100) / 100,
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: Math.round(os.uptime()),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
  }
}

export type SystemStatus = {
  ollama: OllamaStatus
  chroma: ChromaStatus
  cpu: CpuStatus
}

// Probed concurrently: three sequential 4s timeouts would make a fully-broken
// host take 12s to say so.
export const readSystemStatus = async (): Promise<SystemStatus> => {
  const [ollama, chroma] = await Promise.all([readOllama(), readChroma()])
  return { ollama, chroma, cpu: readCpu() }
}
