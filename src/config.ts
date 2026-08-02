import { homedir, hostname } from "os";
import { join } from "path";

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

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

export const config = {
  // Which computer this process is running on. Several machines sync into the
  // same database, so every project a sync stamps carries its origin. Falls
  // back to the OS hostname, which inside a container is the container id —
  // set MACHINE_NAME explicitly in compose for anything meaningful.
  machine: getEnv("MACHINE_NAME", hostname()),

  logs: {
    // Every process ships console output to the shared `logs` table. At the
    // observed ~265KB/day for a sync container this is a few MB per machine
    // per fortnight; set 0 to keep everything.
    retentionDays: getEnvInt("LOG_RETENTION_DAYS", 14),
  },

  // PostgreSQL
  postgres: {
    host: getEnv("POSTGRES_HOST", "localhost"),
    port: getEnvInt("POSTGRES_PORT", 5433),
    user: getEnv("POSTGRES_USER", "mindmeld"),
    password: getEnv("POSTGRES_PASSWORD", "mindmeld"),
    database: getEnv("POSTGRES_DB", "conversations"),
  },

  // Chroma
  chroma: {
    host: getEnv("CHROMA_HOST", "localhost"),
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
    // One ollama on soul, reached over the SSH tunnel. Serves both bge-m3
    // (vectorization) and qwen3 (generation/summarization).
    url: getEnv("OLLAMA_URL", "http://localhost:11434"),
    timeoutMs: getEnvInt("OLLAMA_TIMEOUT_MS", 120000), // 2 minutes
    maxRetries: getEnvInt("OLLAMA_MAX_RETRIES", 3),
    retryDelayMs: getEnvInt("OLLAMA_RETRY_DELAY_MS", 5000), // 5 seconds between retries
    // Max requests crossing the SSH tunnel to soul at once. The tunnel — not the
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
    summarizeModel: getEnv("SUMMARIZE_MODEL", "qwen3:8b"),
  },

  // Source paths
  sources: {
    claudeCode: {
      path: expandPath(getEnv("CLAUDE_CODE_PATH", "~/.claude")),
      name: "claude_code",
    },
    cursor: {
      path: expandPath(getEnv("CURSOR_PATH", "~/.cursor/chats")),
      name: "cursor",
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
