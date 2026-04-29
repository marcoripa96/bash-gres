export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | Date
  | string[]
  | number[];

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: SqlParam[],
  ): Promise<QueryResult<T>>;

  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

export class SqlError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly detail?: string,
    public readonly constraint?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "SqlError";
  }
}

export class FsError extends Error {
  constructor(
    public readonly code: string,
    public readonly op: string,
    public readonly path: string,
  ) {
    super(`${code}: ${op}, '${path}'`);
    this.name = "FsError";
  }
}

export class FsQuotaError extends FsError {
  constructor(
    op: string,
    path: string,
    public readonly limit: number,
    public readonly current: number,
    public readonly attemptedDelta: number,
  ) {
    super("ENOSPC", op, path);
    this.name = "FsQuotaError";
  }
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface DirentStatEntry extends DirentEntry {
  mode: number;
  size: number;
  mtime: Date;
  symlinkTarget: string | null;
}

export interface WalkEntry extends DirentStatEntry {
  path: string;
  depth: number;
}

export interface SearchResult {
  path: string;
  name: string;
  rank: number;
  snippet?: string;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

export interface ReadFileRangeOptions {
  offset?: number;
  limit?: number;
}

export interface ReadFileLinesOptions {
  /** 1-indexed line number to start from. Default 1. */
  offset?: number;
  /** Maximum number of lines to return. Default: read to end. */
  limit?: number;
}

export interface ReadFileLinesResult {
  /** The requested slice of lines, joined by `\n`. No trailing newline. */
  content: string;
  /** Total number of lines in the file (excludes the empty element after a trailing newline). */
  total: number;
}

export interface SetupOptions {
  enableRLS?: boolean;
  enableFullTextSearch?: boolean;
  enableVectorSearch?: boolean;
  embeddingDimensions?: number;
  skipExtensions?: boolean;
}

export interface FsPermissions {
  read?: boolean;
  write?: boolean;
}

// -- Versioning primitives --------------------------------------------------

export type NodeType = "file" | "directory" | "symlink";

/** Public-facing shape of an entry at a single path in some version. */
export interface EntryShape {
  type: NodeType;
  mode: number;
  size: number;
  mtime: Date;
  /** Hex-encoded sha256 of the file's blob. `null` for directories and symlinks. */
  blobHash: string | null;
  /** Symlink target as stored. `null` for files and directories. */
  symlinkTarget: string | null;
}

export interface VersionDiffEntry {
  path: string;
  change: "added" | "removed" | "modified" | "type-changed";
  before: EntryShape | null;
  after: EntryShape | null;
}

export type MergeStrategy = "fail" | "ours" | "theirs";

export interface ConflictEntry {
  path: string;
  base: EntryShape | null;
  ours: EntryShape | null;
  theirs: EntryShape | null;
}

export interface MergeResult {
  applied: string[];
  conflicts: ConflictEntry[];
  skipped: string[];
}

export interface RenameVersionResult {
  label: string;
  displacedLabel?: string;
}

export interface PromoteResult {
  label: string;
  displacedLabel?: string;
  droppedPrevious: boolean;
}

export interface WorkspaceUsage {
  workspaceId: string;
  /** Version used for visible/logical counts. */
  version: string;
  /** User path used for visible/logical counts. */
  path: string;
  /** Sum of visible file and symlink sizes in this version. */
  logicalBytes: number;
  /** Deduplicated blob bytes referenced by visible files under `path`. */
  referencedBlobBytes: number;
  /** Deduplicated bytes stored in fs_blobs for the whole workspace. */
  storedBlobBytes: number;
  /** Number of blobs stored for the whole workspace. */
  blobCount: number;
  /** Number of version labels in the workspace. */
  versions: number;
  /** Total fs_entries rows across all versions, including tombstones. */
  entryRows: number;
  /** Tombstone rows across all versions. */
  tombstoneRows: number;
  /** Visible non-tombstone nodes in this version, including root. */
  visibleNodes: number;
  visibleFiles: number;
  visibleDirectories: number;
  visibleSymlinks: number;
  limits: {
    maxFiles: number;
    maxFileSize: number;
    maxWorkspaceBytes?: number;
  };
}

export interface WorkspaceUsageOptions {
  /** Scope visible/logical counts to this user path and its descendants. */
  path?: string;
}

import type { FsCache } from "./cache.js";

export interface PgFileSystemOptions {
  db: SqlClient;
  workspaceId?: string;
  version?: string;
  permissions?: FsPermissions;
  rootDir?: string;
  /**
   * Optional read-side cache. When provided, read operations consult the cache
   * first; mutations clear all entries for the current workspace+version after
   * the underlying transaction commits. Reads issued inside a `transaction(fn)`
   * facade bypass the cache entirely so the facade sees its own uncommitted
   * writes.
   */
  cache?: FsCache;
  /** Optional TTL applied to all cache entries this filesystem writes. */
  cacheTtlMs?: number;
  /** Maximum size of a single file write, in bytes. Default: 10 MiB. */
  maxFileSize?: number;
  /** If set, `readFile` rejects files larger than this many bytes. Default: unlimited. */
  maxReadSize?: number;
  /** Maximum number of entries (files + directories) per workspace. Default: 10000. */
  maxFiles?: number;
  /** Maximum deduplicated blob bytes per workspace. Default: unlimited. */
  maxWorkspaceBytes?: number;
  /** Maximum path depth (number of `/`-separated segments). Default: 50. */
  maxDepth?: number;
  /** Maximum levels of symlink indirection before ELOOP. Default: 16. */
  maxSymlinkDepth?: number;
  /** Maximum number of nodes a single `cp -r` may traverse. Default: 10000. */
  maxCpNodes?: number;
  statementTimeoutMs?: number;
  embed?: (text: string) => Promise<number[]>;
  embeddingDimensions?: number;
}
