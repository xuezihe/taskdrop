/**
 * PROTOTYPE - THROW AWAY.
 *
 * Portable canonical Space Key encoding and validation. The caller owns the
 * entropy source; this module performs no I/O and persists nothing.
 */

const SPACE_KEY_PREFIX = "tdp_";
const SPACE_KEY_PATTERN = /^tdp_[A-Za-z0-9_-]{43}$/;
const SPACE_KEY_BYTES = 32;

export function encodeSpaceKey(entropy: Uint8Array): string {
  if (entropy.byteLength !== SPACE_KEY_BYTES) {
    throw new Error(`Space Key entropy must be exactly ${SPACE_KEY_BYTES} bytes`);
  }

  const encoded = Buffer.from(entropy).toString("base64url");
  const key = `${SPACE_KEY_PREFIX}${encoded}`;

  if (!isCanonicalSpaceKey(key)) {
    throw new Error("Generated Space Key failed its canonical-format invariant");
  }

  return key;
}

export function isCanonicalSpaceKey(value: string): boolean {
  if (!SPACE_KEY_PATTERN.test(value)) {
    return false;
  }

  const encoded = value.slice(SPACE_KEY_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64url");

  return decoded.byteLength === SPACE_KEY_BYTES && decoded.toString("base64url") === encoded;
}
