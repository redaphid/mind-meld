import { homedir, hostname, platform } from "os";
import { existsSync } from "fs";
import { join } from "path";

// Which operating system this process runs on (#33). `process.platform` is
// not enough on its own: WSL reports `linux`, but its `/mnt/<letter>` mounts
// are Windows drives on a case-insensitive filesystem — the one distinction
// project-path comparison actually depends on. So WSL gets its own value.
//
// Detection is deliberately narrow. `os.release()` carries `microsoft` inside
// any container on Docker Desktop's WSL2 backend too, where the filesystem is
// the container's and nothing is drvfs; the interop markers below are set for
// a real WSL distro only, so a containerized sync correctly reports `linux`.
function detectOs(): string {
  if (platform() !== "linux") return platform();
  const inWsl = Boolean(process.env.WSL_DISTRO_NAME) || existsSync("/run/WSL");
  return inWsl ? "wsl" : "linux";
}

function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

// Separate from getEnvInt because the ranking knobs are fractions: parseInt on
// "0.35" yields 0, which would read as "feature off" while looking configured.
function getEnvFloat(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

// A comma-separated env var as a list. An explicitly empty value ("") means an
// empty list, not "fall back to the default" -- otherwise a setting like
// MINDMELD_DEFAULT_EXCLUDED_TAGS could never be turned off from the
// environment, only changed to something else.
function getEnvList(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const config = {
  // Which computer this process is running on. Several machines sync into the
  // same database, so every project a sync stamps carries its origin. Falls
  // back to the OS hostname, which inside a container is the container id —
  // set MACHINE_NAME explicitly in compose for anything meaningful.
  machine: getEnv("MACHINE_NAME", hostname()),

  // The operating system that machine runs, sent automatically with every
  // project and session — callers never pass it, the same no-burden rule as
  // path normalization (#33). Overridable for a relay that knows better than
  // its own platform.
  os: getEnv("MACHINE_OS", detectOs()),

  logs: {
    // Every process ships console output to the shared `logs` table. At the
    // observed ~265KB/day for a sync container this is a few MB per machine
    // per fortnight; set 0 to keep everything.
    retentionDays: getEnvInt("LOG_RETENTION_DAYS", 14),
  },

  tags: {
    // Tags whose presence hides a session from search unless the caller asks
    // for them by name. "useless" is the first member and the reason the set
    // exists: it replaces a separate soft-delete flag with one ordinary tag,
    // so hiding a session stays reversible (task 326).
    //
    // Configurable precisely so a second hidden tag never needs a code change.
    // Note this is the ONLY place tags are treated specially -- the vocabulary
    // itself stays open, and nothing here restricts what tags may be created.
    defaultExcluded: getEnvList("MINDMELD_DEFAULT_EXCLUDED_TAGS", ["useless"]),
  },

  ranking: {
    // How hard a result that RESEMBLES your `useless`-tagged sessions is pushed
    // down. Distinct from defaultExcluded above: that hides the sessions you
    // labelled, this demotes the ones you never got to.
    //
    // Applied multiplicatively -- score *= (1 - beta * max(0, similarity)) --
    // so the scale is fixed: 0 reproduces the previous ranking exactly, 1 sends
    // a perfectly useless-aligned result to zero. It must NOT be additive: the
    // fused RRF score tops out around 0.066, so an additive term would have to
    // be hand-matched to RRF_K and the arm count, and would silently stop
    // meaning the same thing if either changed.
    //
    // 0.35 is a deliberate default rather than a tuned optimum -- measured
    // separation is strong (unlabelled sessions average -0.015 against the
    // direction), so a moderate value reorders the genuinely bad without
    // letting one signal dominate relevance. Explore with `pnpm run search:tune`.
    uselessPenalty: getEnvFloat("MINDMELD_USELESS_PENALTY", 0.35),
  },

  // PostgreSQL
  postgres: {
    host: getEnv("POSTGRES_HOST", "127.0.0.1"),
    port: getEnvInt("POSTGRES_PORT", 5433),
    user: getEnv("POSTGRES_USER", "mindmeld"),
    password: getEnv("POSTGRES_PASSWORD", "mindmeld"),
    database: getEnv("POSTGRES_DB", "conversations"),
    // How long to wait for a connection from the pool. Was hardcoded at 2000ms,
    // which is generous inside the compose network and too tight from a Windows
    // host, where Docker Desktop's port forwarding can take several seconds to
    // establish the first connection. That presented as "Connection terminated
    // unexpectedly" from every script run on the host -- a message that says
    // nothing about timeouts and reads like an auth or server problem.
    //
    // A longer limit costs nothing where connecting is fast; it only changes how
    // long the slow case waits before giving up.
    connectionTimeoutMs: getEnvInt("POSTGRES_CONNECTION_TIMEOUT_MS", 10000),
    // Max pooled connections. 20 is right inside the compose network, but a
    // script run on a Windows HOST cannot open that many at once: Docker
    // Desktop's port forwarding drops concurrent connection attempts to a
    // published port, and every one of them fails with "Connection terminated
    // unexpectedly" -- measured at 12 of 12 failing while a single connection
    // succeeded every time. Scripts that fan out queries set this to 1 and
    // serialize instead of failing.
    poolMax: getEnvInt("POSTGRES_POOL_MAX", 20),
  },

  // Chroma
  chroma: {
    host: getEnv("CHROMA_HOST", "127.0.0.1"),
    port: getEnvInt("CHROMA_PORT", 8001),
    get url() {
      return `http://${this.host}:${this.port}`;
    },
    collections: {
      messages: "convo-messages",
      sessions: "convo-sessions",
      projects: "convo-projects",
      chunks: "convo-chunks",
    },
  },

  // Ollama
  ollama: {
    // One Ollama on the GPU host, reached over the SSH tunnel. Serves both bge-m3
    // (vectorization) and qwen3 (generation/summarization).
    //
    // 127.0.0.1, never `localhost`: Ollama binds IPv4 only, so a `localhost`
    // that resolves to ::1 first gets ECONNREFUSED against a server that is
    // running fine.
    url: getEnv("OLLAMA_URL", "http://127.0.0.1:11434"),
    timeoutMs: getEnvInt("OLLAMA_TIMEOUT_MS", 120000), // 2 minutes
    // The ceiling for a query someone is waiting on, which is a different
    // question entirely from how long a background batch may take.
    //
    // A search embeds its query through the same gated client as the batch
    // pipeline, so on a closed gate it inherited the batch settings: three
    // attempts, each Retry-After clamped to retryMaxDelayMs, ~120 seconds of
    // silence before the caller got FTS-only results anyway. Nobody waits two
    // minutes for a search box. The vector arm is an *enhancement* over
    // full-text here — when it cannot be had promptly, the honest move is to
    // return the full-text results now and say they are degraded.
    //
    // Bounds the whole interactive attempt: one try, no retries, and no more
    // than this long queueing for the tunnel slot either.
    //
    // Not tighter than this on purpose. A single request over the SSH tunnel
    // measures ~4-6s (see maxConcurrency below), so a 4s deadline would keep
    // cutting off embeds that were about to succeed — and every one of those is
    // a search quietly answered from full text alone. The failure this bounds
    // is a gate holding work for minutes; it does not need a tight number to
    // catch that, and a loose one costs nothing when the vector arrives.
    interactiveTimeoutMs: getEnvInt("OLLAMA_INTERACTIVE_TIMEOUT_MS", 8000),
    maxRetries: getEnvInt("OLLAMA_MAX_RETRIES", 3),
    retryDelayMs: getEnvInt("OLLAMA_RETRY_DELAY_MS", 5000), // 5 seconds between retries
    // Ceiling on how long a single 503 Retry-After may park a request. A GPU
    // gate in front of Ollama can legitimately ask for its whole cooldown
    // (ollama-proxy defaults to 900s), and obeying that verbatim would stall a
    // sync run for a quarter of an hour per attempt with no way to interrupt
    // it. Clamping keeps the backoff honest — we still wait, just in bounded
    // steps, and the next attempt re-reads a fresh Retry-After.
    retryMaxDelayMs: getEnvInt("OLLAMA_RETRY_MAX_DELAY_MS", 60000), // 1 minute
    // Max requests crossing the SSH tunnel to that host at once. The tunnel — not the
    // GPU — is the bottleneck: one request is ~4-6s, but concurrent ones saturate
    // it and each balloons to ~30s. Serialize (1) by default; raise only if Ollama
    // moves onto the same host as the sync (then the tunnel is gone).
    maxConcurrency: getEnvInt("OLLAMA_MAX_CONCURRENCY", 1),
  },

  // Embeddings
  embeddings: {
    model: getEnv("EMBEDDING_MODEL", "bge-m3"),
    dimensions: getEnvInt("EMBEDDING_DIMENSIONS", 1024),
    batchSize: getEnvInt("EMBEDDING_BATCH_SIZE", 100),
    // The one default. docker-compose.yml repeats the literal because compose
    // cannot read it from here — keep them in step, and prefer changing this one
    // first. An -instruct build is required: a `thinking` model emits its
    // reasoning untagged through /api/generate, and neither `think: false`, the
    // /no_think prefix, nor stripThinking removes it.
    summarizeModel: getEnv("SUMMARIZE_MODEL", "qwen3:4b-instruct"),
  },

  // Source paths
  sources: {
    claudeCode: {
      path: expandPath(getEnv("CLAUDE_CODE_PATH", "~/.claude")),
      name: "claude_code",
    },
  },

  // Sync
  sync: {
    intervalMinutes: getEnvInt("SYNC_INTERVAL_MINUTES", 60),
    incremental: getEnvBool("SYNC_INCREMENTAL", true),
  },

  // Embedding healing
  healing: {
    retryLimit: getEnvInt("HEALING_RETRY_LIMIT", 3),
    cooldownDays: getEnvInt("HEALING_COOLDOWN_DAYS", 7),
  },

  // Logging
  logLevel: getEnv("LOG_LEVEL", "info"),
} as const;

export type Config = typeof config;
