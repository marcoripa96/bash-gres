export type SqlParam = string | number | boolean | null | Uint8Array | Date | string[];

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

export interface SearchResult {
  path: string;
  name: string;
  rank: number;
  snippet?: string;
}

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

export interface ReadFileOptions {
  offset?: number;
  limit?: number;
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
  permissions?: FsPermissions;
  maxFileSize?: number;
  maxReadSize?: number;
  maxFiles?: number;
  maxDepth?: number;
  statementTimeoutMs?: number;
  embed?: (text: string) => Promise<number[]>;
  embeddingDimensions?: number;
}
