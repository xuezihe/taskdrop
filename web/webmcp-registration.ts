import type { HandoffWorkspaceController, WorkspaceState } from "./handoff-workspace-controller.js";
import { createHandoffWebMcpTools } from "./webmcp-tools.js";

export interface WebMcpDocument {
  readonly modelContext?: WebMcpModelContext;
}

export interface HandoffWebMcpBinding {
  dispose(): void;
}

export async function registerHandoffWebMcpTools(
  modelContext: WebMcpModelContext,
  controller: HandoffWorkspaceController,
  signal: AbortSignal,
): Promise<void> {
  const tools = createHandoffWebMcpTools(controller, signal);
  await Promise.all(tools.map((tool) => modelContext.registerTool(tool, { signal })));
}

export function bindHandoffWebMcpTools(
  controller: HandoffWorkspaceController,
  hostDocument: WebMcpDocument = document,
): HandoffWebMcpBinding {
  let modelContext: WebMcpModelContext | undefined;
  try {
    modelContext = hostDocument.modelContext;
  } catch {
    return { dispose: () => undefined };
  }
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return { dispose: () => undefined };
  }

  let disposed = false;
  let wasReady = false;
  let registration: AbortController | null = null;

  const stopRegistration = (): void => {
    registration?.abort();
    registration = null;
  };

  const synchronize = (state: WorkspaceState): void => {
    if (disposed) return;
    if (state.kind !== "ready") {
      wasReady = false;
      stopRegistration();
      return;
    }
    if (wasReady) return;

    wasReady = true;
    const nextRegistration = new AbortController();
    registration = nextRegistration;
    void registerHandoffWebMcpTools(modelContext, controller, nextRegistration.signal).catch(() => {
      nextRegistration.abort();
      if (registration === nextRegistration) registration = null;
    });
  };

  const unsubscribe = controller.subscribe((state) => synchronize(state));
  synchronize(controller.getState());

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopRegistration();
    },
  };
}
