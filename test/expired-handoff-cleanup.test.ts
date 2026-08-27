import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLEANUP_INTERVAL_MS,
  startExpiredHandoffCleanup,
  type CleanupObservation,
} from "../src/production/expired-handoff-cleanup.js";

function deferred(): {
  promise: Promise<number>;
  resolve(value: number): void;
} {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("expired Handoff cleanup lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the initial pass asynchronously, then schedules another pass one hour later", async () => {
    vi.useFakeTimers();
    const observations: CleanupObservation[] = [];
    let passCount = 0;
    const lifecycle = startExpiredHandoffCleanup({
      cleanupPass: async () => {
        passCount += 1;
        return 3;
      },
      observe: (observation) => observations.push(observation),
    });

    expect(passCount).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(passCount).toBe(1);
    expect(observations).toEqual([
      {
        operation: "cleanup_expired_handoffs",
        deletedHandoffs: 3,
        durationMs: 0,
      },
    ]);

    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS - 1);
    expect(passCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(passCount).toBe(2);

    await lifecycle.stop();
  });

  it("does not overlap passes and stop waits for the in-flight pass", async () => {
    vi.useFakeTimers();
    const firstPass = deferred();
    let passCount = 0;
    const lifecycle = startExpiredHandoffCleanup({
      cleanupPass: () => {
        passCount += 1;
        return firstPass.promise;
      },
      observe: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(passCount).toBe(1);
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 2);
    expect(passCount).toBe(1);

    let stopped = false;
    const stopping = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    firstPass.resolve(0);
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 2);
    expect(passCount).toBe(1);
  });

  it("isolates failure details and retries on the next scheduled pass", async () => {
    vi.useFakeTimers();
    const observations: CleanupObservation[] = [];
    let passCount = 0;
    const lifecycle = startExpiredHandoffCleanup({
      cleanupPass: async () => {
        passCount += 1;
        if (passCount === 1) {
          throw new Error("sensitive SQL and identity details");
        }
        return 2;
      },
      observe: (observation) => observations.push(observation),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(observations).toEqual([{ operation: "cleanup_expired_handoffs", outcome: "failure" }]);
    expect(JSON.stringify(observations)).not.toContain("sensitive");

    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);
    expect(passCount).toBe(2);
    expect(observations[1]).toEqual({
      operation: "cleanup_expired_handoffs",
      deletedHandoffs: 2,
      durationMs: 0,
    });

    await lifecycle.stop();
  });

  it("stop cancels a pending pass and is safe to repeat", async () => {
    vi.useFakeTimers();
    let passCount = 0;
    const lifecycle = startExpiredHandoffCleanup({
      cleanupPass: async () => {
        passCount += 1;
        return 0;
      },
      observe: () => undefined,
    });

    await lifecycle.stop();
    await lifecycle.stop();
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 2);
    expect(passCount).toBe(0);
  });
});
