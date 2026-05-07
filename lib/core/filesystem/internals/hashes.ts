import { createHash } from "crypto";

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function bytesKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function blobHashEqual(
  a: Uint8Array | null,
  b: Uint8Array | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
