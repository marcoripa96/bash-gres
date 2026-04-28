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

export interface PgFileSystemOptions {
  db: SqlClient;
  workspaceId?: string;
  version?: string;
  permissions?: FsPermissions;
  rootDir?: string;
  /** Maximum size of a single file write, in bytes. Default: 10 MiB. */
  maxFileSize?: number;
  /** If set, `readFile` rejects files larger than this many bytes. Default: unlimited. */
  maxReadSize?: number;
  /** Maximum number of entries (files + directories) per workspace. Default: 10000. */
  maxFiles?: number;
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
