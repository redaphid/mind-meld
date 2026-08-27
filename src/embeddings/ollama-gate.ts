import { config } from "../config.js";

// All Ollama traffic from this process crosses one SSH tunnel to the GPU host. A single
// request through it is fast (~4-6s); concurrent requests saturate the tunnel
// and each balloons to ~30s. So we serialize: at most OLLAMA_MAX_CONCURRENCY
// requests occupy the tunnel at once. The bottleneck is transport, not the GPU
// (Ollama on that host handles 5 concurrent in ~2.7s), so gating here costs nothing
// the tunnel wasn't already taking — it just stops calls from stampeding it.
const max = config.ollama.maxConcurrency;

let active = 0;
const queue: (() => void)[] = [];

// Thrown when a caller that cannot afford to wait did not get a slot in time.
// Distinct from an Ollama failure: the upstream was never asked, so the caller
// still has the option of doing without the answer.
export class OllamaBusyError extends Error {
  constructor(waitMs: number) {
    super(`No Ollama slot free within ${waitMs}ms`);
    this.name = "OllamaBusyError";
  }
}

const acquire = (waitMs?: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (active < max) {
      active++;
      resolve();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = () => {
      if (timer) clearTimeout(timer);
      active++;
      resolve();
    };
    queue.push(waiter);

    if (waitMs === undefined) return;
    timer = setTimeout(() => {
      // Removing the waiter is what makes the bounded wait safe. Left in place
      // it would still be shifted off by a later release(), incrementing
      // `active` on behalf of a caller that has already given up — leaking one
      // slot per timeout until the gate is permanently shut.
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(new OllamaBusyError(waitMs));
    }, waitMs);
    // A queued interactive request must never be the reason the process
    // refuses to exit.
    timer.unref?.();
  });

const release = (): void => {
  active--;
  queue.shift()?.();
};

// Run fn while holding a tunnel slot. Released even if fn throws, so a failed
// request never wedges the gate.
//
// `waitMs` bounds only the queueing, not fn itself: a caller with a deadline
// (an interactive search) gives up rather than sitting behind a session
// summarization that owns the single slot for 5-10 minutes. Omitted — every
// background caller — means wait indefinitely, which is what keeps the batch
// pipeline serialized rather than dropping work.
export const withOllamaGate = async <T>(
  fn: () => Promise<T>,
  waitMs?: number,
): Promise<T> => {
  await acquire(waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
};
