/**
 * PROTOTYPE - THROW AWAY.
 *
 * Question: is a one-shot local Space Key generator enough to serve as the
 * first V1 setup entry while the Web Setup Page and Local Keyring are deferred?
 */

import { randomBytes } from "node:crypto";

import { encodeSpaceKey } from "./space-key.js";

if (process.argv.length > 2) {
  const argument = process.argv[2];
  if (argument === "--help" || argument === "-h") {
    printHelp();
    process.exit(0);
  }

  console.error(`Unknown argument: ${argument}`);
  printHelp();
  process.exit(2);
}

const key = encodeSpaceKey(randomBytes(32));

console.log("TaskDrop Space Key");
console.log("");
console.log(key);
console.log("");
console.log("Generated locally from 32 CSPRNG bytes. This CLI does not save it.");
console.log("Keep the exact value: whitespace, padding, and case changes are invalid.");
console.log("");
console.log("Preferred carrier: Authorization: Bearer <Space Key>");
console.log("Query carrier: taskdropKey on the exact /mcp endpoint only.");
console.log("Warning: Query credentials are visible to URL-handling infrastructure.");

function printHelp(): void {
  console.log("Usage: pnpm prototype:setup-cli");
  console.log("");
  console.log("Generates one canonical TaskDrop Space Key and persists nothing.");
}
