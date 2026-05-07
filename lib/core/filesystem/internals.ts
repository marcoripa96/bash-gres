import { createHash } from "crypto";
import { SqlError } from "../types.js";
import type { EntryShape, NodeType } from "../types.js";

// -- Row shapes -------------------------------------------------------------

export interface EntryRow {
  workspace_id: string;
  version_id: number;
  path: string;
  blob_hash: Uint8Array | null;
  node_type: string;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
  created_at: Date;
}

export interface BlobRow {
  hash: Uint8Array;
  content: string | null;
  binary_data: Uint8Array | null;
  size_bytes: number;
}

export interface DirChildRow {
  path: string;
  node_type: string;
  blob_hash: Uint8Array | null;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
}

export interface SubtreeRow extends DirChildRow {
  depth_in_subtree: number;
}

export interface DiffRow {
  path: string;
  o_type: string | null;
  o_hash: Uint8Array | null;
  o_link: string | null;
  o_mode: number | null;
  o_size: number | string | null;
  o_mtime: Date | null;
  t_type: string | null;
  t_hash: Uint8Array | null;
  t_link: string | null;
  t_mode: number | null;
  t_size: number | string | null;
  t_mtime: Date | null;
}

export interface UsageRow {
  versions: number | string;
  entry_rows: number | string;
  tombstone_rows: number | string;
  blob_count: number | string;
  stored_blob_bytes: number | string;
  referenced_blob_bytes: number | string;
  visible_nodes: number | string;
  visible_files: number | string;
  visible_directories: number | string;
  visible_symlinks: number | string;
  logical_bytes: number | string;
}

export interface VersionRootRow {
  id: number | string;
  path: string;
}

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

// -- Constants --------------------------------------------------------------

export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_FILES = 10_000;
export const DEFAULT_MAX_DEPTH = 50;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_SYMLINK_DEPTH = 16;
export const DEFAULT_MAX_CP_NODES = 10_000;

export const DEFAULT_VERSION = "main";
export const TOMBSTONE = "tombstone";
export const DIFF_DEFAULT_BATCH_SIZE = 500;
export const DIFF_MAX_BATCH_SIZE = 5000;

// -- Free helpers -----------------------------------------------------------

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function bytesKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Build the displaced-label format used by `renameVersion({ swap: true })`:
 * `<newLabel>-prev-YYYYMMDDHHMMSS-<displacedId>`. The trailing version ID
 * makes the label unique within a workspace even if two swaps land in the
 * same UTC second.
 */
export function generatePrevLabel(newLabel: string, displacedId: number): string {
  const now = new Date();
  const ts =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0");
  return `${newLabel}-prev-${ts}-${displacedId}`;
}

/**
 * Map a PostgreSQL unique-violation (`23505`) on the version-label index
 * to a clear public error. Other errors pass through unchanged.
 */
export function mapVersionLabelUniqueViolation(
  e: unknown,
  label: string,
): unknown {
  if (
    e instanceof SqlError &&
    e.code === "23505" &&
    (e.constraint === "unique_workspace_version_label" ||
      e.constraint === "unique_workspace_version_root_label" ||
      (e.detail ?? "").includes("workspace_id") ||
      e.message.includes("unique_workspace_version_label") ||
      e.message.includes("unique_workspace_version_root_label"))
  ) {
    return new Error(
      `renameVersion: label '${label}' is already used by another version.`,
    );
  }
  return e;
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

// -- Glob helpers -----------------------------------------------------------

// path-encoding's `encodeLabel` is not exported here; mirror the encoding for
// a single basename. The encoded last label of an ltree is exactly
// `encodeLabel(basename)`. Re-implemented inline to avoid leaking another
// export from path-encoding.
export function encodeBasenameForLtree(name: string): string {
  if (name.length === 0) throw new Error("Cannot encode empty basename");
  let result = "";
  for (const char of name) {
    if (char === "\0") throw new Error("Filenames cannot contain null bytes");
    if (/[A-Za-z0-9\-]/.test(char)) {
      result += char;
    } else {
      const hex = char
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(2, "0");
      result += `_x${hex}_`;
    }
  }
  return result;
}

export function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += pattern[i + 2] === "/" ? 3 : 2;
    } else if (char === "*") {
      regex += "[^/]*";
      i++;
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const options = pattern
          .slice(i + 1, close)
          .split(",")
          .map(escapeRegex)
          .join("|");
        regex += `(?:${options})`;
        i = close + 1;
      } else {
        regex += escapeRegex(char);
        i++;
      }
    } else {
      regex += escapeRegex(char);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

export function globLiteralPrefix(pattern: string): string | null {
  const segments = pattern.split("/");
  const prefix: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") break;
    if (/[?*{]/.test(segment)) break;
    prefix.push(segment);
  }
  return prefix.length > 0 ? prefix.join("/") : null;
}

export function analyzeGlobPattern(
  pattern: string,
  literalPrefix: string | null,
): {
  exact: boolean;
  fixedDepth: number | null;
  basename: string | null;
} {
  const relative = stripGlobLiteralPrefix(pattern, literalPrefix);
  if (relative === "") {
    return { exact: true, fixedDepth: 0, basename: null };
  }
  const segments = relative.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? null;
  return {
    exact: false,
    fixedDepth: segments.includes("**") ? null : segments.length,
    basename:
      basename !== null && !/[?*{]/.test(basename) ? basename : null,
  };
}

function stripGlobLiteralPrefix(
  pattern: string,
  literalPrefix: string | null,
): string {
  if (!literalPrefix) return pattern;
  const prefixSegments = literalPrefix.split("/").filter(Boolean).length;
  return pattern.split("/").slice(prefixSegments).join("/");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
