import { config } from "../config.js";

// All Ollama traffic from this process crosses one SSH tunnel to soul. A single
// request through it is fast (~4-6s); concurrent requests saturate the tunnel
// and each balloons to ~30s. So we serialize: at most OLLAMA_MAX_CONCURRENCY
// requests occupy the tunnel at once. The bottleneck is transport, not the GPU
// (Ollama on soul handles 5 concurrent in ~2.7s), so gating here costs nothing
// the tunnel wasn't already taking — it just stops calls from stampeding it.
const max = config.ollama.maxConcurrency;

let active = 0;
const queue: (() => void)[] = [];

const acquire = (): Promise<void> =>
  new Promise((resolve) => {
    if (active < max) {
      active++;
      resolve();
      return;
    }
    queue.push(() => {
      active++;
      resolve();
    });
  });

const release = (): void => {
  active--;
  queue.shift()?.();
};

// Run fn while holding a tunnel slot. Released even if fn throws, so a failed
// request never wedges the gate.
export const withOllamaGate = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};
