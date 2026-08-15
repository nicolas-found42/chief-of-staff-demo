import { sha256 } from "js-sha256";

/**
 * Platform-neutral byte utilities. Every engine hash, entropy draw, and
 * UTF-8 conversion goes through here so the same code runs in Node and the
 * browser (WebCrypto + js-sha256) without node:* imports.
 */

/** Cryptographically secure random bytes. Node >= 19 and all browsers expose
 * getRandomValues on the global crypto object. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function sha256Hex(data: Uint8Array | string): string {
  return sha256(data);
}

export function sha256Digest(text: string): Uint8Array {
  return new Uint8Array(sha256.arrayBuffer(text));
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8ByteLength(text: string): number {
  return utf8Bytes(text).byteLength;
}

/** Constant-time-insensitive byte equality (length check short-circuits). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** RFC 4648 base64url encoding without padding (Buffer parity). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
