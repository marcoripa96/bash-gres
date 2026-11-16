import type { RenameVersionResult, SqlClient, SqlParam } from "../../types.js";
import type { InternalEntryShape } from "../internals/entry-shapes.js";
import type { PreparedBlob } from "../internals/hashes.js";

export const filesystemOpsContext: unique symbol = Symbol(
  "filesystemOpsContext",
);

/** Where a one-statement write runs: see `fastWriteTarget()`. */
export interface FastWriteTarget {
  client: SqlClient;
  versionId: number;
  statementTimeoutMs: number;
}

export interface FilesystemOpsHost<TFs> {
  [filesystemOpsContext](): FilesystemOpsContext<TFs>;
}

export interface FilesystemTransactionOps {
  detach(): Promise<void>;
  freeze(): Promise<void>;
  renameVersion(
    newLabel: string,
    opts?: { swap?: boolean },
  ): Promise<RenameVersionResult>;
  deleteVersion(version: string): Promise<void>;
}

export interface FilesystemOpsContext<TFs> {
  readonly workspaceId: string;
  readonly versionLabel: string;
  readonly maxFiles: number;
  readonly maxFileSize: number;
  readonly maxWorkspaceBytes: number | undefined;
  readonly historyRetention: "retain" | "discard";

  guardRead(userPath: string): string;
  /** writeFile's guards (mounts, rootDir, excludes); returns the internal path. */
  guardWrite(userPath: string): string;
  /** writeFile's size and depth limits. */
  validateWrite(internalPath: string, content: string | Uint8Array): void;
  /**
   * The client and version for a one-statement write, or `null` when this
   * handle must take the transactional path: read-only, version id not yet
   * known, a workspace byte quota, or chunking. On an fs.transaction()
   * facade the client is the facade's transaction.
   */
  fastWriteTarget(): FastWriteTarget | null;
  toInternalPath(userPath: string): string;
  toUserPath(internalPath: string): string;
  buildExcludeClause(
    pathExpr: string,
    nextParamIdx: number,
  ): { sql: string; params: SqlParam[] };
  buildMountClause(
    pathExpr: string,
    nextParamIdx: number,
  ): { sql: string; params: SqlParam[] };

  withWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  /** A workspace transaction without the shared blob guard (collector only). */
  withWorkspaceUnguarded<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  /** `true` on an fs.transaction() facade. */
  readonly inTransaction: boolean;
  withReadOnlyWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  transaction<T>(
    fn: (tx: TFs & FilesystemTransactionOps) => Promise<T>,
  ): Promise<T>;

  getVersionRootId(tx: SqlClient): Promise<number>;
  /**
   * The error for an op whose version row is gone (workspace dropped or
   * version root removed after the handle resolved it); resets the cache.
   */
  forgetVersionError(): Error;
  getCurrentVersionId(tx: SqlClient): Promise<number>;
  requireVersionIdByLabel(tx: SqlClient, label: string): Promise<number>;
  lockVersions(tx: SqlClient, versionIds: number[]): Promise<void>;
  findLCA(tx: SqlClient, idA: number, idB: number): Promise<number | null>;
  globalVisibleCount(tx: SqlClient, versionId: number): Promise<number>;
  fetchVisibleEntryMap(
    tx: SqlClient,
    versionId: number,
    scopeLtree: string,
  ): Promise<Map<string, InternalEntryShape>>;
  writeEntryShape(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    shape: InternalEntryShape | null,
  ): Promise<void>;
  writeEntryShapes(
    tx: SqlClient,
    versionId: number,
    writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
  ): Promise<void>;
  storeBlob(
    tx: SqlClient,
    internalPath: string,
    blob: PreparedBlob,
  ): Promise<void>;
  /**
   * Overwrite or shadow the file at `internalPath` with `blob`, keeping
   * `mode`, in one statement (plus quota and chunk upkeep when enabled).
   */
  overwriteFile(
    tx: SqlClient,
    versionId: number,
    internalPath: string,
    blob: PreparedBlob,
    mode: number,
  ): Promise<void>;
  /** writeFile's transactional path: parents, node count, quota, chunks. */
  writeNewFile(
    tx: SqlClient,
    versionId: number,
    internalPath: string,
    content: string | Uint8Array,
  ): Promise<void>;

  createVersionedFilesystem(
    internalPath: string,
    version: string,
    versionRootId: number,
    versionId?: number,
  ): TFs;
  createForkedFilesystem(newVersion: string): TFs;
  setVersionLabelAfterRename(label: string): void;
}

export function op<
  TOperation extends <TFs>(
    ctx: FilesystemOpsContext<TFs>,
    ...args: never[]
  ) => unknown,
>(operation: TOperation): TOperation {
  return operation;
}
