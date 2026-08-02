/**
 * PROTOTYPE - THROW AWAY.
 *
 * Pure state model for correlating sanitized MCP observations with the hosted
 * ChatGPT lifecycle stage selected by the operator.
 */

export type LifecycleStage =
  | "preflight"
  | "tool-scan"
  | "first-call"
  | "later-call"
  | "reopened-conversation"
  | "refresh-reconnect";

export type AuthenticationOutcome =
  | "accepted"
  | "missing"
  | "malformed-authorization"
  | "invalid-format"
  | "conflicting";

export type LifecycleObservation = {
  sequence: number;
  stage: LifecycleStage;
  httpMethod: string;
  path: "/mcp";
  rpcMethod: string;
  toolName?: string;
  authentication: AuthenticationOutcome;
  credentialCarrier?: "bearer" | "query" | "both";
  credentialFingerprint?: string;
  credentialMatchedExpected: boolean;
  declaredProtocolVersion: string;
  requestHadSession: boolean;
  responseStatus: number;
  responseHadSession: boolean;
};

export class LifecycleRecorder {
  #stage: LifecycleStage = "preflight";
  #sequence = 0;
  readonly #observations: LifecycleObservation[] = [];

  get stage(): LifecycleStage {
    return this.#stage;
  }

  setStage(stage: Exclude<LifecycleStage, "preflight">): void {
    this.#stage = stage;
  }

  record(
    observation: Omit<LifecycleObservation, "sequence" | "stage">,
  ): LifecycleObservation {
    if (this.#stage === "tool-scan" && observation.rpcMethod === "tools/call") {
      this.#stage = "first-call";
    }
    const recorded = {
      sequence: ++this.#sequence,
      stage: this.#stage,
      ...observation,
    };
    this.#observations.push(recorded);
    return recorded;
  }

  snapshot(): {
    currentStage: LifecycleStage;
    observations: readonly LifecycleObservation[];
  } {
    return {
      currentStage: this.#stage,
      observations: [...this.#observations],
    };
  }
}
