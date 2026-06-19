import { describe, it, expect } from "vitest";
import { withOllamaGate } from "./ollama-gate.js";

// A deferred promise we resolve by hand, so we can hold tasks "in flight".
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("withOllamaGate", () => {
  it("never lets more than the configured limit run at once", async () => {
    // Default limit is 1 (OLLAMA_MAX_CONCURRENCY). Fire three at once and prove
    // only one is ever in flight.
    let active = 0;
    let peak = 0;
    const gates = [defer(), defer(), defer()];

    const runs = gates.map((g, i) =>
      withOllamaGate(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
        return i;
      }),
    );

    // Let microtasks settle: exactly one task should have entered.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(1);

    // Drain them one at a time; peak must stay at the limit.
    for (const g of gates) {
      g.resolve();
      await Promise.resolve();
    }
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(peak).toBe(1);
  });

  it("releases the slot when the task throws, so the gate never wedges", async () => {
    await expect(
      withOllamaGate(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the slot leaked, this second call would hang forever.
    const result = await withOllamaGate(async () => "recovered");
    expect(result).toBe("recovered");
  });
});
