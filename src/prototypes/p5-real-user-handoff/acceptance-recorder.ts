/**
 * PROTOTYPE - THROW AWAY.
 *
 * Pure, sanitized state for labeling a manually driven P5 acceptance run.
 */

export type AcceptanceStage =
  | "setup"
  | "devin-readiness"
  | "devin-source"
  | "codex-continuation"
  | "devin-resume";

export type AcceptanceObservation = {
  sequence: number;
  stage: AcceptanceStage;
  rpcMethod: string;
  toolName?: string;
  authentication: string;
  credentialCarrier?: "bearer" | "query" | "both";
  scopeHash?: string;
  declaredProtocolVersion: string;
  requestHadSession: boolean;
  responseStatus: number;
  responseHadSession: boolean;
};

export class AcceptanceRecorder {
  #stage: AcceptanceStage = "setup";
  #sequence = 0;
  readonly #observations: AcceptanceObservation[] = [];

  get stage(): AcceptanceStage {
    return this.#stage;
  }

  setStage(stage: Exclude<AcceptanceStage, "setup">): void {
    this.#stage = stage;
  }

  record(observation: Omit<AcceptanceObservation, "sequence" | "stage">): AcceptanceObservation {
    const recorded = {
      sequence: ++this.#sequence,
      stage: this.#stage,
      ...observation,
    };
    this.#observations.push(recorded);
    return recorded;
  }

  snapshot(): {
    currentStage: AcceptanceStage;
    observations: readonly AcceptanceObservation[];
  } {
    return {
      currentStage: this.#stage,
      observations: [...this.#observations],
    };
  }
}
