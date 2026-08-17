import { formatSpaceKey } from "../src/production/space-identity.js";

const SPACE_KEY_BYTES = 32;

export type FillRandomBytes = (target: Uint8Array) => Uint8Array;

export function createSpaceKey(fillRandomBytes: FillRandomBytes): string {
  const entropy = new Uint8Array(SPACE_KEY_BYTES);
  fillRandomBytes(entropy);
  return formatSpaceKey(entropy);
}
