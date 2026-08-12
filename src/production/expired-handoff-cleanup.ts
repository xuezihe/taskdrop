export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const CLEANUP_OPERATION = "cleanup_expired_handoffs";

export type CleanupObservation =
  | {
      operation: typeof CLEANUP_OPERATION;
      outcome: "success";
      deletedHandoffs: number;
      durationMs: number;
    }
  | {
      operation: typeof CLEANUP_OPERATION;
      outcome: "failure";
    };

export interface ExpiredHandoffCleanupLifecycle {
  stop(): Promise<void>;
}

export function startExpiredHandoffCleanup(input: {
  cleanupPass(): Promise<number>;
  observe(observation: CleanupObservation): void;
}): ExpiredHandoffCleanupLifecycle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const observe = (observation: CleanupObservation): void => {
    try {
      input.observe(observation);
    } catch {
      // Observation must not change cleanup or Application lifecycle behavior.
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      runPass();
    }, delayMs);
    timer.unref();
  };

  const runPass = (): void => {
    if (stopped || inFlight) return;
    const startedAt = Date.now();
    inFlight = (async () => {
      try {
        const deletedHandoffs = await input.cleanupPass();
        observe({
          operation: CLEANUP_OPERATION,
          outcome: "success",
          deletedHandoffs,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        observe({ operation: CLEANUP_OPERATION, outcome: "failure" });
      }
    })().finally(() => {
      inFlight = null;
      schedule(CLEANUP_INTERVAL_MS);
    });
  };

  schedule(0);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}
