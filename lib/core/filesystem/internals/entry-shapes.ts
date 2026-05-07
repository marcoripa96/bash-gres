import type { EntryShape, NodeType } from "../../types.js";
import { blobHashEqual } from "./hashes.js";

/**
 * Internal representation of an entry's data, used by batch primitives
 * (diff/merge/cherry-pick/revert/detach) to apply pre-fetched rows back into
 * `fs_entries` without re-reading or re-hashing content. Mirrors the public
 * `EntryShape` from `types.ts`, but holds a raw `Uint8Array` blob hash for
 * direct binding to PostgreSQL. `mtime` is the source row's mtime; the write
 * path stamps `now()` regardless and ignores this field.
 */
export interface InternalEntryShape {
  type: "file" | "directory" | "symlink";
  blobHash: Uint8Array | null;
  symlinkTarget: string | null;
  mode: number;
  sizeBytes: number;
  mtime: Date;
}

/**
 * Semantic equality for entry shapes. Compares `type`, `blob_hash`,
 * `symlink_target`, and `mode`. Ignores `mtime`, `size_bytes`, `created_at`.
 * `size_bytes` is derived from blob/symlink content; comparing it would be
 * redundant with `blob_hash` and `symlink_target`.
 */
export function entryShapeEqual(
  a: InternalEntryShape | null,
  b: InternalEntryShape | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  if (a.mode !== b.mode) return false;
  if ((a.symlinkTarget ?? null) !== (b.symlinkTarget ?? null)) return false;
  return blobHashEqual(a.blobHash, b.blobHash);
}

/**
 * Convert an `InternalEntryShape` (with raw `Uint8Array` blob hash) into the
 * public `EntryShape` (with hex-encoded blob hash). Used for `merge()` /
 * `cherryPick()` / `revert()` conflict reports.
 */
export function toPublicEntryShape(
  s: InternalEntryShape | null,
): EntryShape | null {
  if (s === null) return null;
  return {
    type: s.type,
    blobHash: s.blobHash ? Buffer.from(s.blobHash).toString("hex") : null,
    symlinkTarget: s.symlinkTarget,
    mode: s.mode,
    size: s.sizeBytes,
    mtime: s.mtime,
  };
}

export function mapDiffSide(
  type: string | null,
  hash: Uint8Array | null,
  symlinkTarget: string | null,
  mode: number | null,
  size: number | string | null,
  mtime: Date | null,
): EntryShape | null {
  if (type === null) return null;
  return {
    type: type as NodeType,
    blobHash: hash ? Buffer.from(hash).toString("hex") : null,
    symlinkTarget,
    mode: mode ?? 0,
    size: size === null ? 0 : Number(size),
    mtime: mtime ?? new Date(0),
  };
}

export function classifyDiffChange(
  before: EntryShape | null,
  after: EntryShape | null,
): "added" | "removed" | "modified" | "type-changed" {
  if (before === null) return "added";
  if (after === null) return "removed";
  if (before.type !== after.type) return "type-changed";
  return "modified";
}
