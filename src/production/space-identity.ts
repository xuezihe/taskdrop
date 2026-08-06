const SPACE_ID_DOMAIN = new TextEncoder().encode("taskdrop.space-id.v1\0");
const SPACE_FINGERPRINT_DOMAIN = new TextEncoder().encode("taskdrop.space-fingerprint.v1\0");

const SPACE_KEY_PREFIX = "tdp_";
const SPACE_KEY_PATTERN = /^tdp_[A-Za-z0-9_-]{43}$/;
const SPACE_KEY_BYTES = 32;

const B64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < B64URL_CHARS.length; i++) {
  B64URL_LOOKUP[B64URL_CHARS.charCodeAt(i)] = i;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL_CHARS[b0 >> 2]!;
    out += B64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) {
      out += B64URL_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    }
    if (i + 2 < bytes.length) {
      out += B64URL_CHARS[b2 & 0x3f]!;
    }
  }
  return out;
}

function decodeBase64Url(str: string): Uint8Array {
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let oi = 0;
  for (let i = 0; i < str.length; i += 4) {
    const c0 = B64URL_LOOKUP[str.charCodeAt(i)]!;
    const c1 = i + 1 < str.length ? B64URL_LOOKUP[str.charCodeAt(i + 1)]! : -1;
    const c2 = i + 2 < str.length ? B64URL_LOOKUP[str.charCodeAt(i + 2)]! : -1;
    const c3 = i + 3 < str.length ? B64URL_LOOKUP[str.charCodeAt(i + 3)]! : -1;
    if (c0 < 0 || c1 < 0) throw new Error("invalid base64url");
    out[oi++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[oi++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0) out[oi++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.subarray(0, oi);
}

export function formatSpaceKey(entropy: Uint8Array): string {
  if (entropy.length !== SPACE_KEY_BYTES) {
    throw new Error(`Space Key entropy must be exactly ${SPACE_KEY_BYTES} bytes`);
  }
  const key = `${SPACE_KEY_PREFIX}${encodeBase64Url(entropy)}`;
  if (!isCanonicalSpaceKey(key)) {
    throw new Error("Generated Space Key failed its canonical-format invariant");
  }
  return key;
}

export function isCanonicalSpaceKey(value: string): boolean {
  if (!SPACE_KEY_PATTERN.test(value)) return false;
  const encoded = value.slice(SPACE_KEY_PREFIX.length);
  const decoded = decodeBase64Url(encoded);
  return decoded.length === SPACE_KEY_BYTES && encodeBase64Url(decoded) === encoded;
}

export function parseSpaceKey(key: string): Uint8Array {
  if (!isCanonicalSpaceKey(key)) {
    throw new Error("invalid Space Key");
  }
  return decodeBase64Url(key.slice(SPACE_KEY_PREFIX.length));
}

const HEX_PATTERN = /^[0-9a-f]{64}$/;

export function parseSpaceId(hex: string): Uint8Array {
  if (!HEX_PATTERN.test(hex)) {
    throw new Error("invalid Space ID");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function domainSeparatedDigest(domain: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const data = new Uint8Array(domain.length + input.length);
  data.set(domain, 0);
  data.set(input, domain.length);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

export async function deriveSpaceId(keyBytes: Uint8Array): Promise<Uint8Array> {
  return domainSeparatedDigest(SPACE_ID_DOMAIN, keyBytes);
}

export async function deriveSpaceFingerprint(spaceId: Uint8Array): Promise<string> {
  const digest = await domainSeparatedDigest(SPACE_FINGERPRINT_DOMAIN, spaceId);
  return encodeBase64Url(digest.subarray(0, 9));
}
