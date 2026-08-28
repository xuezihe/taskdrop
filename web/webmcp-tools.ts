import { z } from "zod";

import type {
  HandoffWorkspaceController,
  WorkspaceError,
  WorkspaceState,
} from "./handoff-workspace-controller.js";

export const WEBMCP_TOOL_NAMES = [
  "get_handoff_context",
  "get_revision_history",
  "read_revision",
  "update_working_draft",
  "commit_working_draft",
] as const;

export type HandoffWebMcpToolName = (typeof WEBMCP_TOOL_NAMES)[number];
export type HandoffWebMcpTool = WebMcpToolDefinition & { readonly name: HandoffWebMcpToolName };

export type HandoffContext = {
  code: string;
  latestRevision: number;
  latestMarkdown: string;
  latestOrigin: "mcp" | "human" | "webmcp";
  expiresAt: string;
  workingDraft: null | {
    baseRevision: number;
    markdown: string;
    lastModifiedVia: "human" | "webmcp";
    contributors: ("human" | "webmcp")[];
  };
};

type ToolErrorResult =
  | { ok: false; error: WorkspaceError }
  | { ok: false; error: { code: "INVALID_REQUEST" } }
  | { ok: false; error: { code: "INTERNAL_ERROR" } };

const noInputSchema = z.object({}).strict();
const revisionInputSchema = z
  .object({
    revision: z.number().int().positive().refine(Number.isSafeInteger),
  })
  .strict();
const updateDraftInputSchema = z.object({ markdown: z.string() }).strict();

const NO_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const REVISION_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    revision: {
      type: "integer",
      minimum: 1,
      description: "Positive Revision number to read from the current Handoff.",
    },
  },
  required: ["revision"],
  additionalProperties: false,
} as const;

const UPDATE_DRAFT_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    markdown: {
      type: "string",
      description: "Complete Markdown content for the shared Working Draft.",
    },
  },
  required: ["markdown"],
  additionalProperties: false,
} as const;

const INVALID_REQUEST: ToolErrorResult = {
  ok: false,
  error: { code: "INVALID_REQUEST" },
};
const INTERNAL_ERROR: ToolErrorResult = {
  ok: false,
  error: { code: "INTERNAL_ERROR" },
};
const REQUEST_CANCELLED: ToolErrorResult = {
  ok: false,
  error: { code: "REQUEST_CANCELLED" },
};
const WORKSPACE_NOT_READY: ToolErrorResult = {
  ok: false,
  error: { code: "WORKSPACE_NOT_READY" },
};

export function createHandoffWebMcpTools(
  controller: HandoffWorkspaceController,
  lifecycleSignal?: AbortSignal,
): readonly HandoffWebMcpTool[] {
  return [
    {
      name: "get_handoff_context",
      title: "Get Handoff Context",
      description:
        "Read the current committed Handoff and shared Working Draft in this page without changing either.",
      inputSchema: NO_INPUT_JSON_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, options) =>
        safelyExecute(async () => {
          if (!noInputSchema.safeParse(input).success) return INVALID_REQUEST;
          if (isCancelled(options.signal, lifecycleSignal)) return REQUEST_CANCELLED;
          return contextFromState(controller.getState());
        }),
    },
    {
      name: "get_revision_history",
      title: "Get Revision History",
      description:
        "List immutable Revision metadata for the Handoff open in this page without changing it.",
      inputSchema: NO_INPUT_JSON_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input, options) =>
        safelyExecute(async () => {
          if (!noInputSchema.safeParse(input).success) return INVALID_REQUEST;
          const signal = combineSignals(options.signal, lifecycleSignal);
          if (signal.aborted) return REQUEST_CANCELLED;
          const result = await controller.getRevisionHistory(signal);
          return result.ok ? result.value.revisions : result;
        }),
    },
    {
      name: "read_revision",
      title: "Read Revision",
      description: "Read one immutable historical Revision from the Handoff open in this page.",
      inputSchema: REVISION_INPUT_JSON_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, options) =>
        safelyExecute(async () => {
          const parsed = revisionInputSchema.safeParse(input);
          if (!parsed.success) return INVALID_REQUEST;
          const signal = combineSignals(options.signal, lifecycleSignal);
          if (signal.aborted) return REQUEST_CANCELLED;
          const result = await controller.readRevision(parsed.data.revision, signal);
          if (!result.ok) return result;
          return {
            revision: result.value.revision,
            markdown: result.value.markdown,
            createdAt: result.value.createdAt,
            origin: result.value.origin,
          };
        }),
    },
    {
      name: "update_working_draft",
      title: "Update Working Draft",
      description:
        "Replace the complete shared Working Draft in this page and show the change in the editor.",
      inputSchema: UPDATE_DRAFT_INPUT_JSON_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: true },
      execute: (input, options) =>
        safelyExecute(async () => {
          const parsed = updateDraftInputSchema.safeParse(input);
          if (!parsed.success) return INVALID_REQUEST;
          if (isCancelled(options.signal, lifecycleSignal)) return REQUEST_CANCELLED;
          const update = controller.updateMarkdown(parsed.data.markdown, "webmcp");
          if (!update.ok) return update;
          return contextFromState(controller.getState());
        }),
    },
    {
      name: "commit_working_draft",
      title: "Commit Working Draft",
      description:
        "Append the shared Working Draft as a new immutable Revision using its recorded base and provenance.",
      inputSchema: NO_INPUT_JSON_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: true },
      execute: (input, options) =>
        safelyExecute(async () => {
          if (!noInputSchema.safeParse(input).success) return INVALID_REQUEST;
          const signal = combineSignals(options.signal, lifecycleSignal);
          if (signal.aborted) return REQUEST_CANCELLED;
          const result = await controller.commit(signal);
          return result.ok ? result.value : result;
        }),
    },
  ];
}

function contextFromState(state: WorkspaceState): HandoffContext | ToolErrorResult {
  if (state.kind !== "ready") return WORKSPACE_NOT_READY;
  return {
    code: state.committed.code,
    latestRevision: state.committed.latestRevision,
    latestMarkdown: state.committed.markdown,
    latestOrigin: state.committed.origin,
    expiresAt: state.committed.expiresAt,
    workingDraft: state.workingDraft
      ? {
          baseRevision: state.workingDraft.baseRevision,
          markdown: state.workingDraft.markdown,
          lastModifiedVia: state.workingDraft.lastModifiedVia,
          contributors: [...state.workingDraft.contributors],
        }
      : null,
  };
}

function combineSignals(executionSignal: AbortSignal, lifecycleSignal: AbortSignal | undefined) {
  return lifecycleSignal ? AbortSignal.any([executionSignal, lifecycleSignal]) : executionSignal;
}

function isCancelled(
  executionSignal: AbortSignal,
  lifecycleSignal: AbortSignal | undefined,
): boolean {
  return executionSignal.aborted || lifecycleSignal?.aborted === true;
}

async function safelyExecute(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action();
  } catch {
    return INTERNAL_ERROR;
  }
}
