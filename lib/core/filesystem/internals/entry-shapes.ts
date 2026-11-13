import type {
  EntryShape,
  NodeType,
  VersionDiffEntry,
  VersionDiffOptions,
} from "../../types.js";
import { createUnifiedDiff } from "../../text-diff.js";
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

/**
 * Resolve a `fs_blobs` row into text content for a diff entry. Returns
 * `null` for non-files (directories, symlinks, absent side); falls back to
 * UTF-8 decoding of `binary_data` when the row has no `content` column —
 * the storage layer chooses one or the other based on whether the blob
 * was originally text.
 */
export function decodeBlobContent(
  side: EntryShape | null,
  content: string | null,
  binary: Uint8Array | null,
): string | null {
  if (side === null || side.type !== "file") return null;
  if (content !== null) return content;
  if (binary !== null) return new TextDecoder().decode(binary);
  return "";
}

/** What a diff fetch adds to each entry beyond its shapes. */
export interface DiffContentMode {
  /** Populate `beforeContent` / `afterContent`. */
  content: boolean;
  /** Populate `unifiedDiff` with this many context lines; `null` = off. */
  unified: { context: number } | null;
}

export const NO_DIFF_CONTENT: DiffContentMode = { content: false, unified: null };

export function diffContentMode(opts?: VersionDiffOptions): DiffContentMode {
  const u = opts?.unifiedDiff;
  return {
    content: opts?.includeContent ?? false,
    unified:
      u === undefined || u === false
        ? null
        : { context: u === true ? 3 : (u.context ?? 3) },
  };
}

/** True when the fetch must join `fs_blobs` for either side's content. */
export function needsBlobContent(mode: DiffContentMode): boolean {
  return mode.content || mode.unified !== null;
}

/** An `fs_blobs` row's two content columns. */
export interface BlobColumns {
  content: string | null;
  binary: Uint8Array | null;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A blob's text, strictly: the `content` column, else `binary_data` when it
 * is valid UTF-8, else `null` (binary). Both columns null (a file with no
 * blob) is `""`. Unlike `decodeBlobContent`, never decodes lossily, so the
 * text is safe to merge or diff.
 */
export function blobText(blob: BlobColumns): string | null {
  if (blob.content !== null) return blob.content;
  if (blob.binary === null) return "";
  try {
    return strictUtf8.decode(blob.binary);
  } catch {
    return null;
  }
}

/**
 * Fill the content fields `mode` asks for on a diff entry, from the raw blob
 * columns of both sides.
 */
export function fillDiffContent(
  entry: VersionDiffEntry,
  mode: DiffContentMode,
  beforeBlob: BlobColumns,
  afterBlob: BlobColumns,
): void {
  const { before, after } = entry;
  if (mode.content) {
    entry.beforeContent = decodeBlobContent(before, beforeBlob.content, beforeBlob.binary);
    entry.afterContent = decodeBlobContent(after, afterBlob.content, afterBlob.binary);
  }
  if (mode.unified === null) return;
  const nonFile = (s: EntryShape | null) => s !== null && s.type !== "file";
  if (nonFile(before) || nonFile(after)) {
    entry.unifiedDiff = null;
    return;
  }
  // Both sides are files or absent here; absent diffs against /dev/null.
  const a = before === null ? null : blobText(beforeBlob);
  const b = after === null ? null : blobText(afterBlob);
  const binary = (side: EntryShape | null, text: string | null) =>
    side !== null && text === null;
  if (binary(before, a) || binary(after, b) || a === b) {
    entry.unifiedDiff = null;
    return;
  }
  entry.unifiedDiff = createUnifiedDiff(a, b, {
    path: entry.path,
    context: mode.unified.context,
  });
}
