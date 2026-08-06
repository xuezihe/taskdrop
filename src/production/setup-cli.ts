import { randomBytes } from "node:crypto";

import { formatSpaceKey, isCanonicalSpaceKey } from "./space-identity.js";

function main(): void {
  const key = formatSpaceKey(randomBytes(32));
  if (!isCanonicalSpaceKey(key)) {
    process.stderr.write("internal error: generated key failed validation\n");
    process.exit(1);
  }

  process.stdout.write("TaskDrop Space Key\n\n");
  process.stdout.write(`${key}\n\n`);
  process.stdout.write("Generated locally from 32 CSPRNG bytes. This CLI does not save it.\n");
  process.stdout.write("Retain the exact spelling: whitespace, padding, and case changes are invalid.\n\n");
  process.stdout.write("Preferred carrier: Authorization: Bearer <Space Key>\n");
  process.stdout.write("Query carrier: taskdropKey on the exact /mcp endpoint only.\n");
  process.stdout.write("Warning: Query credentials are visible to URL-handling infrastructure.\n");
}

main();
