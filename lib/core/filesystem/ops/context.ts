import type { RenameVersionResult, SqlClient, SqlParam } from "../../types.js";
import type { InternalEntryShape } from "../internals/entry-shapes.js";

export const filesystemOpsContext: unique symbol = Symbol(
  "filesystemOpsContext",
);

export interface FilesystemOpsHost<TFs> {
  [filesystemOpsContext](): FilesystemOpsContext<TFs>;
}

export interface FilesystemTransactionOps {
  detach(): Promise<void>;
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
  toInternalPath(userPath: string): string;
  toUserPath(internalPath: string): string;
  buildExcludeClause(
    pathExpr: string,
    nextParamIdx: number,
  ): { sql: string; params: SqlParam[] };

  withWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  withReadOnlyWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  transaction<T>(
    fn: (tx: TFs & FilesystemTransactionOps) => Promise<T>,
  ): Promise<T>;

  getVersionRootId(tx: SqlClient): Promise<number>;
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

  createVersionedFilesystem(
    internalPath: string,
    version: string,
    versionRootId: number,
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
