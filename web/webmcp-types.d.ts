interface WebMcpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly untrustedContentHint?: boolean;
}

interface WebMcpToolExecuteOptions {
  readonly signal: AbortSignal;
}

interface WebMcpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: WebMcpToolAnnotations;
  execute(input: unknown, options: WebMcpToolExecuteOptions): Promise<unknown>;
}

interface WebMcpToolRegistrationOptions {
  readonly signal?: AbortSignal;
  readonly exposedTo?: readonly string[];
}

interface WebMcpModelContext {
  registerTool(tool: WebMcpToolDefinition, options?: WebMcpToolRegistrationOptions): Promise<void>;
}

interface Document {
  readonly modelContext?: WebMcpModelContext;
}
