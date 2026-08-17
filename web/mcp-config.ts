export type BearerMcpFields = {
  url: string;
  transport: "http";
  headers: { Authorization: string };
};

export type QueryMcpFields = {
  url: string;
  transport: "http";
};

export function mcpEndpoint(origin: string): string {
  return `${origin}/mcp`;
}

export function queryCredentialUrl(origin: string, spaceKey: string): string {
  return `${mcpEndpoint(origin)}?taskdropKey=${spaceKey}`;
}

export function bearerMcpFields(origin: string, spaceKey: string): BearerMcpFields {
  return {
    url: mcpEndpoint(origin),
    transport: "http",
    headers: { Authorization: `Bearer ${spaceKey}` },
  };
}

export function queryMcpFields(origin: string, spaceKey: string): QueryMcpFields {
  return {
    url: queryCredentialUrl(origin, spaceKey),
    transport: "http",
  };
}

export function formatMcpSnippet(name: string, fields: BearerMcpFields | QueryMcpFields): string {
  return `"${name}": ${JSON.stringify(fields, null, 2)}`;
}
