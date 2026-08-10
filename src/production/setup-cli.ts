import { randomBytes } from "node:crypto";

import { formatSpaceKey, isCanonicalSpaceKey } from "./space-identity.js";

function main(): void {
  const key = formatSpaceKey(randomBytes(32));
  if (!isCanonicalSpaceKey(key)) {
    process.stderr.write("internal error: generated key failed validation\n");
    process.exit(1);
  }

  const lines = [
    "TaskDrop Space Key",
    "",
    key,
    "",
    "Generated locally from 32 CSPRNG bytes. This CLI does not save it.",
    "Retain the exact spelling: whitespace, padding, and case changes are invalid.",
    "",
    "MCP server fields",
    "Replace <YOUR_TASKDROP_ORIGIN> with the origin hosting TaskDrop.",
    "Copy one field into your MCP server configuration.",
    "For non-JSON client configurations, map the same field names and values.",
    "",
    "Query carrier",
    "Warning: Query credentials are visible to URL-handling infrastructure.",
    "",
    '"taskdrop-query": {',
    `  "url": "<YOUR_TASKDROP_ORIGIN>/mcp?taskdropKey=${key}",`,
    '  "transport": "http"',
    "}",
    "",
    "Bearer carrier (recommended)",
    "",
    '"taskdrop-bearer": {',
    '  "url": "<YOUR_TASKDROP_ORIGIN>/mcp",',
    '  "transport": "http",',
    '  "headers": {',
    `    "Authorization": "Bearer ${key}"`,
    "  }",
    "}",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
