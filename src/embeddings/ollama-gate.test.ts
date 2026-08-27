import { describe, it, expect } from "vitest";
import { withOllamaGate, OllamaBusyError } from "./ollama-gate.js";

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

  // The slot is held for the whole of a request, and a session summarization
  // holds it for 5-10 minutes. A search cannot sit behind that, so it may give
  // up while queued — but giving up must not disturb the queue for anyone else.
  describe("when a caller sets a wait limit", () => {
    it("gives up rather than queueing behind a long request", async () => {
      const held = defer();
      const holder = withOllamaGate(async () => {
        await held.promise;
        return "holder";
      });
      await Promise.resolve();

      await expect(withOllamaGate(async () => "waiter", 10)).rejects.toBeInstanceOf(
        OllamaBusyError,
      );

      held.resolve();
      expect(await holder).toBe("holder");
    });

    it("runs immediately when a slot is already free", async () => {
      expect(await withOllamaGate(async () => "straight through", 10)).toBe(
        "straight through",
      );
    });

    // The failure this guards against is silent and cumulative: a timed-out
    // waiter left in the queue is still shifted off by the next release, which
    // takes a slot on behalf of a caller that has gone. Enough of those and the
    // gate is shut for good, with nothing running.
    it("leaves no phantom waiter behind to consume a slot", async () => {
      const held = defer();
      const holder = withOllamaGate(async () => {
        await held.promise;
        return "holder";
      });
      await Promise.resolve();

      await expect(withOllamaGate(async () => "gone", 10)).rejects.toBeInstanceOf(
        OllamaBusyError,
      );

      held.resolve();
      await holder;

      // The abandoned waiter must not have taken the freed slot with it.
      expect(await withOllamaGate(async () => "after")).toBe("after");
      expect(await withOllamaGate(async () => "and again")).toBe("and again");
    });

    // Background callers pass no limit and must keep the old behaviour: wait
    // as long as it takes rather than dropping queued work.
    it("still waits indefinitely when no limit is given", async () => {
      const held = defer();
      const holder = withOllamaGate(async () => {
        await held.promise;
        return "holder";
      });
      await Promise.resolve();

      const patient = withOllamaGate(async () => "patient");
      held.resolve();

      expect(await holder).toBe("holder");
      expect(await patient).toBe("patient");
    });
  });
});
