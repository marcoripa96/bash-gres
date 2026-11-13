import { createHash } from "crypto";

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** File content encoded and hashed once, ready to store as an `fs_blobs` row. */
export interface PreparedBlob {
  hash: Uint8Array;
  sizeBytes: number;
  /** The `content` column: the text, or `null` for binary content. */
  text: string | null;
  /** The `binary_data` column: the bytes, or `null` for text content. */
  binary: Uint8Array | null;
}

export function prepareBlob(content: string | Uint8Array): PreparedBlob {
  const isText = typeof content === "string";
  const bytes = isText ? new TextEncoder().encode(content) : content;
  return {
    hash: sha256(bytes),
    sizeBytes: bytes.byteLength,
    text: isText ? content : null,
    binary: isText ? null : content,
  };
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
