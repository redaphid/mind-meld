import { homedir } from "os";
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
    },
  },

  // Ollama
  ollama: {
    url: getEnv("OLLAMA_URL", "http://localhost:11434"),
    timeoutMs: getEnvInt("OLLAMA_TIMEOUT_MS", 120000), // 2 minutes
    maxRetries: getEnvInt("OLLAMA_MAX_RETRIES", 3),
    retryDelayMs: getEnvInt("OLLAMA_RETRY_DELAY_MS", 5000), // 5 seconds between retries
  },

  // Embeddings
  embeddings: {
    model: getEnv("EMBEDDING_MODEL", "bge-m3"),
    dimensions: getEnvInt("EMBEDDING_DIMENSIONS", 1024),
    batchSize: getEnvInt("EMBEDDING_BATCH_SIZE", 100),
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
