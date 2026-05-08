import type {
  SqlClient,
  FsStat,
  DirentEntry,
  DirentStatEntry,
  WalkEntry,
  MkdirOptions,
  RmOptions,
  CpOptions,
  ReadFileRangeOptions,
  ReadFileLinesOptions,
  ReadFileLinesResult,
  SearchResult,
  PgFileSystemOptions,
} from "./types.js";
import { FsError } from "./types.js";
import {
  pathToLtree,
  ltreeToPath,
  normalizePath,
  parentPath,
  fileName,
} from "./path-encoding.js";
import {
  fullTextSearch,
  semanticSearch,
  hybridSearch,
  validateEmbedding,
} from "./search.js";
import { FsWriteOpsBase } from "./filesystem/base/write-ops.js";
import { filesystemOpsContext } from "./filesystem/ops/context.js";
import type { FilesystemOpsContext } from "./filesystem/ops/context.js";
import {
  deleteVersionById,
  installFilesystemOps,
  type FilesystemOpsApi,
} from "./filesystem/ops/index.js";
import { isExcluded } from "./exclude.js";
import {
  encodeBasenameForLtree,
  globToRegex,
  globLiteralPrefix,
  analyzeGlobPattern,
} from "./filesystem/internals/glob.js";
import type { SqlParam } from "./types.js";

export class PgFileSystem extends FsWriteOpsBase {
  [filesystemOpsContext](): FilesystemOpsContext<this> {
    const self = this;
    return {
      get workspaceId() {
        return self.workspaceId;
      },
      get versionLabel() {
        return self.versionLabel;
      },
      get maxFiles() {
        return self.maxFiles;
      },
      get maxFileSize() {
        return self.maxFileSize;
      },
      get maxWorkspaceBytes() {
        return self.maxWorkspaceBytes;
      },
      guardRead: (userPath) => self.guardRead(userPath),
      toInternalPath: (userPath) => self.toInternalPath(userPath),
      toUserPath: (internalPath) => self.toUserPath(internalPath),
      buildExcludeClause: (pathExpr, nextParamIdx) =>
        self.buildExcludeClause(pathExpr, nextParamIdx),
      withWorkspace: (fn) => self.withWorkspace(fn),
      withReadOnlyWorkspace: (fn) => self.withReadOnlyWorkspace(fn),
      transaction: (fn) => self.transaction(fn),
      getVersionRootId: (tx) => self.getVersionRootId(tx),
      getCurrentVersionId: (tx) => self.getCurrentVersionId(tx),
      requireVersionIdByLabel: (tx, label) =>
        self.requireVersionIdByLabel(tx, label),
      lockVersions: (tx, versionIds) => self.lockVersions(tx, versionIds),
      findLCA: (tx, idA, idB) => self.findLCA(tx, idA, idB),
      globalVisibleCount: (tx, versionId) =>
        self.globalVisibleCount(tx, versionId),
      fetchVisibleEntryMap: (tx, versionId, scopeLtree) =>
        self.fetchVisibleEntryMap(tx, versionId, scopeLtree),
      writeEntryShape: (tx, versionId, posixPath, shape) =>
        self.writeEntryShape(tx, versionId, posixPath, shape),
      writeEntryShapes: (tx, versionId, writes) =>
        self.writeEntryShapes(tx, versionId, writes),
      createVersionedFilesystem: (internalPath, version, versionRootId) => {
        const Ctor = self.constructor as new (
          opts: PgFileSystemOptions,
        ) => this;
        const scoped = new Ctor({
          ...self.baseOptions,
          db: self.rawDb,
          rootDir: internalPath,
          versionRoot: internalPath,
          version,
        });
        scoped.cachedVersionRootId = versionRootId;
        if (self.txClient) {
          scoped.txClient = self.txClient;
          scoped.postCommitHooks = self.postCommitHooks;
          scoped.originInstance = self.originInstance ?? self;
        }
        return scoped;
      },
      createForkedFilesystem: (newVersion) => {
        const Ctor = self.constructor as new (
          opts: PgFileSystemOptions,
        ) => this;
        const child = new Ctor({
          ...self.baseOptions,
          db: self.rawDb,
          version: newVersion,
        });
        if (self.txClient) {
          child.txClient = self.txClient;
        }
        return child;
      },
      setVersionLabelAfterRename: (label) => {
        self.versionLabel = label;
        if (self.txClient && self.originInstance && self.postCommitHooks) {
          const origin = self.originInstance;
          self.postCommitHooks.push(() => {
            origin.versionLabel = label;
          });
        }
      },
    };
  }

  async init(): Promise<void> {
    await this.withWorkspace(async (tx) => {
      const versionId = await this.ensureVersion(tx);
      const rootLtree = pathToLtree(this.versionRootPath, this.workspaceId);
      const rootInsert = await tx.query(
        `INSERT INTO fs_entries (workspace_id, version_id, path, node_type, mode)
         VALUES ($1, $2, $3::ltree, 'directory', $4)
         ON CONFLICT (workspace_id, version_id, path) DO NOTHING
         RETURNING 1`,
        [this.workspaceId, versionId, rootLtree, 0o755],
      );
      if (this.cachedNodeCount !== null && rootInsert.rows.length > 0) {
        this.cachedNodeCount++;
      }

      if (this.rootDir !== "/") {
        await this.internalMkdir(tx, versionId, this.rootDir, {
          recursive: true,
        });
      }
    });
  }

  async dispose(): Promise<void> {
    await this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      await deleteVersionById(this[filesystemOpsContext](), tx, versionId);
    });
    this.cachedVersionId = null;
  }

  // -- Public API: File I/O ---------------------------------------------------

  async readFile(
    path: string,
    _options?: { encoding?: string | null } | string,
  ): Promise<string> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalReadFile(tx, internal, path);
    });
  }

  private async internalReadFile(
    tx: SqlClient,
    internal: string,
    userPath: string,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<string> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }

    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    // Same flip as resolveEntry, with the CTE materialized as a planner fence
    // so prepared-statement plan caching can't invert the join order. The
    // LEFT JOIN to fs_blobs runs once against the winning row (after LIMIT 1).
    const r = await tx.query<{
      path: string;
      blob_hash: Uint8Array | null;
      node_type: string;
      symlink_target: string | null;
      size_bytes: number | string;
      blob_content: string | null;
      blob_binary_data: Uint8Array | null;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, size_bytes
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.path, e.blob_hash, e.node_type, e.symlink_target, e.size_bytes
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.path::text AS path,
              picked.blob_hash,
              picked.node_type,
              picked.symlink_target,
              picked.size_bytes,
              b.content AS blob_content,
              b.binary_data AS blob_binary_data
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      [this.workspaceId, lt, versionId],
    );

    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalReadFile(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }

    const size = Number(row.size_bytes);
    if (this.maxReadSize !== undefined && size > this.maxReadSize) {
      throw new FsError(
        "E2BIG",
        `file too large to read (${size} bytes, max ${this.maxReadSize}). Use readFileRange with { offset, limit } to read in chunks`,
        userPath,
      );
    }

    if (!row.blob_hash) return "";
    if (row.blob_content !== null) return row.blob_content;
    if (row.blob_binary_data !== null) {
      return new TextDecoder().decode(row.blob_binary_data);
    }
    return "";
  }

  async readFileRange(
    path: string,
    options?: ReadFileRangeOptions,
  ): Promise<string> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalReadFileRange(tx, internal, path, options);
    });
  }

  private async internalReadFileRange(
    tx: SqlClient,
    internal: string,
    userPath: string,
    options?: ReadFileRangeOptions,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<string> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }

    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    const sqlOffset = (options?.offset ?? 0) + 1;
    const sqlLimit = options?.limit;
    const hasLimit = sqlLimit !== undefined;
    // $1 workspace_id, $2 path, $3 versionId, $4 offset, [$5 limit]
    const textExpr = hasLimit ? `substr(b.content, $4, $5)` : `substr(b.content, $4)`;
    const binaryExpr = hasLimit
      ? `substring(b.binary_data FROM $4 FOR $5)`
      : `substring(b.binary_data FROM $4)`;
    const params: SqlParam[] = [this.workspaceId, lt, versionId, sqlOffset];
    if (hasLimit) params.push(sqlLimit);
    // Same fused path-anchored CTE as readFile, but the blob join projects a
    // computed slice instead of the whole content.
    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      blob_hash: Uint8Array | null;
      chunk_text: string | null;
      chunk_binary: Uint8Array | null;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type, symlink_target
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.node_type,
              picked.symlink_target,
              picked.blob_hash,
              ${textExpr} AS chunk_text,
              ${binaryExpr} AS chunk_binary
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      params,
    );

    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalReadFileRange(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        options,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }

    if (!row.blob_hash) return "";
    if (row.chunk_text !== null) return row.chunk_text;
    if (row.chunk_binary !== null) return new TextDecoder().decode(row.chunk_binary);
    return "";
  }

  async readFileLines(
    path: string,
    options?: ReadFileLinesOptions,
  ): Promise<ReadFileLinesResult> {
    const internal = this.guardRead(path);
    const start = options?.offset ?? 1;
    if (start < 1)
      throw new FsError(
        "EINVAL",
        `readFileLines: offset must be >= 1 (got ${start})`,
        path,
      );
    const limit = options?.limit;
    if (limit !== undefined && limit < 1)
      throw new FsError(
        "EINVAL",
        `readFileLines: limit must be >= 1 (got ${limit})`,
        path,
      );
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalReadFileLines(tx, internal, path, start, limit);
    });
  }

  private async internalReadFileLines(
    tx: SqlClient,
    internal: string,
    userPath: string,
    start: number,
    limit: number | undefined,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<ReadFileLinesResult> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }

    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    const end = limit !== undefined ? start + limit - 1 : null;
    // $1 workspace_id, $2 path, $3 versionId, $4 start, [$5 end]
    const sliceExpr = end !== null ? "lines[$4:$5]" : "lines[$4:]";
    const params: SqlParam[] = [this.workspaceId, lt, versionId, start];
    if (end !== null) params.push(end);

    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      blob_hash: Uint8Array | null;
      chunk: string | null;
      total: number | null;
      is_binary: boolean | null;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type, symlink_target
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       ),
       blob AS (
         SELECT b.content, b.binary_data
         FROM picked
         LEFT JOIN fs_blobs b
           ON b.workspace_id = $1 AND b.hash = picked.blob_hash
       ),
       raw AS (
         SELECT string_to_array(content, E'\n') AS arr,
                (content LIKE '%' || E'\n') AS has_trail,
                (content IS NULL AND binary_data IS NOT NULL) AS is_binary
         FROM blob
       ),
       parts AS (
         SELECT
           CASE
             WHEN has_trail AND array_length(arr, 1) IS NOT NULL
               THEN arr[1:array_length(arr, 1) - 1]
             ELSE arr
           END AS lines,
           is_binary
         FROM raw
       )
       SELECT picked.node_type,
              picked.symlink_target,
              picked.blob_hash,
              array_to_string(${sliceExpr}, E'\n') AS chunk,
              coalesce(array_length(lines, 1), 0) AS total,
              is_binary
       FROM picked
       LEFT JOIN parts ON true`,
      params,
    );

    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalReadFileLines(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        start,
        limit,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }
    if (!row.blob_hash) return { content: "", total: 0 };
    if (row.is_binary) {
      throw new FsError(
        "EINVAL",
        "readFileLines is text-only; use readFileRange for binary files",
        userPath,
      );
    }
    return { content: row.chunk ?? "", total: row.total ?? 0 };
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalReadFileBuffer(tx, internal, path);
    });
  }

  private async internalReadFileBuffer(
    tx: SqlClient,
    internal: string,
    userPath: string,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<Uint8Array> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }

    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    // Same fused entry+blob lookup as internalReadFile, but returning binary
    // data alongside text so readFileBuffer can avoid the separate getBlob.
    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      blob_hash: Uint8Array | null;
      blob_content: string | null;
      blob_binary_data: Uint8Array | null;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, size_bytes
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.node_type,
              picked.symlink_target,
              picked.blob_hash,
              b.content AS blob_content,
              b.binary_data AS blob_binary_data
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      [this.workspaceId, lt, versionId],
    );

    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalReadFileBuffer(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }

    if (!row.blob_hash) return new Uint8Array(0);
    if (row.blob_binary_data !== null) return row.blob_binary_data;
    if (row.blob_content !== null) return new TextEncoder().encode(row.blob_content);
    return new Uint8Array(0);
  }

  /**
   * Run a Postgres SQL/JSON path query directly against a stored file's
   * JSONB-cast content and return the array of matched values.
   *
   * Pushes the JSON parse + filter into Postgres so only projected results
   * cross the wire. Throws `ENOENT` if the file is missing, `EISDIR` for
   * directories, and surfaces Postgres parse errors when the file is not
   * valid JSON or the path expression is malformed.
   *
   * When `options.arrayCheckPath` is provided, the value at that path
   * inside the document must be a JSON array; otherwise the method returns
   * `null` so the caller can fall back to an in-Node evaluator (this is
   * used by the jq pushdown to preserve insertion-order semantics for
   * object iteration). An empty array means "check the document root".
   */
  async queryJsonPath(
    path: string,
    jsonPathExpr: string,
    options?: { arrayCheckPath?: string[] },
  ): Promise<unknown[] | null> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalQueryJsonPath(
        tx,
        internal,
        path,
        jsonPathExpr,
        options?.arrayCheckPath,
      );
    });
  }

  private async internalQueryJsonPath(
    tx: SqlClient,
    internal: string,
    userPath: string,
    jsonPathExpr: string,
    arrayCheckPath: string[] | undefined,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<unknown[] | null> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    const params: SqlParam[] = [this.workspaceId, lt, versionId, jsonPathExpr];
    let resultsExpr: string;
    if (arrayCheckPath !== undefined) {
      let parentExpr: string;
      if (arrayCheckPath.length === 0) {
        parentExpr = "b.content::jsonb";
      } else {
        params.push(arrayCheckPath);
        parentExpr = "(b.content::jsonb #> $5)";
      }
      resultsExpr = `CASE jsonb_typeof(${parentExpr})
                       WHEN 'array' THEN jsonb_path_query_array(b.content::jsonb, $4::jsonpath)
                       ELSE NULL
                     END`;
    } else {
      resultsExpr = "jsonb_path_query_array(b.content::jsonb, $4::jsonpath)";
    }
    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      blob_hash: Uint8Array | null;
      results: unknown;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type, symlink_target
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.node_type,
              picked.symlink_target,
              picked.blob_hash,
              ${resultsExpr} AS results
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      params,
    );

    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalQueryJsonPath(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        jsonPathExpr,
        arrayCheckPath,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }
    const raw = row.results;
    if (raw === null || raw === undefined) {
      return arrayCheckPath !== undefined ? null : [];
    }
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  }

  /**
   * Run a Postgres-side aggregation (`length` / `sum` / `min` / `max`) over
   * the JSON array at `jsonPath` inside the file's content. Returns
   * `{ value }` when the aggregation completed and the result (parsed from
   * jsonb) — `value` may itself be `null` (e.g. `add` of an empty array).
   * Returns top-level `null` when the value at `jsonPath` is not a JSON
   * array, or when the aggregation requires numeric elements and the
   * array contains non-numbers — the caller should fall back to in-Node
   * evaluation in that case.
   */
  async queryJsonAggregate(
    path: string,
    jsonPath: string[],
    kind: AggregateSqlKind,
    options?: {
      keyPath?: string[];
      stringArg?: string;
      replacementArg?: string;
      numericArg?: number;
    },
  ): Promise<{ value: unknown } | null> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalQueryJsonAggregate(
        tx,
        internal,
        path,
        jsonPath,
        kind,
        options?.keyPath,
        options?.stringArg,
        options?.replacementArg,
        options?.numericArg,
      );
    });
  }

  private async internalQueryJsonAggregate(
    tx: SqlClient,
    internal: string,
    userPath: string,
    jsonPath: string[],
    kind: AggregateSqlKind,
    keyPath: string[] | undefined,
    stringArg: string | undefined,
    replacementArg: string | undefined,
    numericArg: number | undefined,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<{ value: unknown } | null> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    const params: SqlParam[] = [this.workspaceId, lt, versionId];
    let parentExpr: string;
    if (jsonPath.length === 0) {
      parentExpr = "b.content::jsonb";
    } else {
      params.push(jsonPath);
      parentExpr = "(b.content::jsonb #> $4)";
    }
    let keyParamIdx: number | null = null;
    if (keyPath !== undefined) {
      params.push(keyPath);
      keyParamIdx = params.length;
    }
    let stringArgIdx: number | null = null;
    if (stringArg !== undefined) {
      params.push(stringArg);
      stringArgIdx = params.length;
    }
    let replacementArgIdx: number | null = null;
    if (replacementArg !== undefined) {
      params.push(replacementArg);
      replacementArgIdx = params.length;
    }
    const aggExpr = aggregateSqlExpr(
      parentExpr,
      kind,
      keyParamIdx,
      stringArgIdx,
      replacementArgIdx,
      numericArg,
    );
    const inputType = aggregateInputType(kind);
    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      blob_hash: Uint8Array | null;
      result: unknown;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type, symlink_target
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.node_type,
              picked.symlink_target,
              picked.blob_hash,
              CASE jsonb_typeof(${parentExpr})
                WHEN '${inputType}' THEN ${aggExpr}
                ELSE NULL
              END AS result
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      params,
    );
    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalQueryJsonAggregate(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        jsonPath,
        kind,
        keyPath,
        stringArg,
        replacementArg,
        numericArg,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }
    const raw = row.result;
    if (raw === null || raw === undefined) return null;
    return { value: raw };
  }

  /**
   * Run a Postgres-side `map({k: <path>, ...})` over the JSON array at
   * `jsonPath`. For each element, builds an object with the given keys
   * mapped to `element #> path`. Returns the result as a single JS array
   * (already wrapped). `null` when the value at `jsonPath` is not a JSON
   * array (caller falls back).
   */
  async queryJsonMapObject(
    path: string,
    jsonPath: string[],
    pairs: Array<{ key: string; valuePath: string[] }>,
  ): Promise<{ value: unknown } | null> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalQueryJsonMapObject(
        tx,
        internal,
        path,
        jsonPath,
        pairs,
      );
    });
  }

  private async internalQueryJsonMapObject(
    tx: SqlClient,
    internal: string,
    userPath: string,
    jsonPath: string[],
    pairs: Array<{ key: string; valuePath: string[] }>,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<{ value: unknown } | null> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    const params: SqlParam[] = [this.workspaceId, lt, versionId];
    let parentExpr: string;
    if (jsonPath.length === 0) {
      parentExpr = "b.content::jsonb";
    } else {
      params.push(jsonPath);
      parentExpr = "(b.content::jsonb #> $4)";
    }
    const argParts: string[] = [];
    for (const pair of pairs) {
      params.push(pair.key);
      const keyIdx = params.length;
      params.push(pair.valuePath);
      const valIdx = params.length;
      argParts.push(`$${keyIdx}::text, value #> $${valIdx}`);
    }
    const buildExpr =
      argParts.length === 0
        ? "'{}'::jsonb"
        : `jsonb_build_object(${argParts.join(", ")})`;
    const aggExpr = `(SELECT COALESCE(jsonb_agg(${buildExpr}), '[]'::jsonb)
                     FROM jsonb_array_elements(${parentExpr}))`;
    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      result: unknown;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type, symlink_target
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.node_type,
              picked.symlink_target,
              CASE jsonb_typeof(${parentExpr})
                WHEN 'array' THEN ${aggExpr}
                ELSE NULL
              END AS result
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      params,
    );
    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalQueryJsonMapObject(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        jsonPath,
        pairs,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }
    const raw = row.result;
    if (raw === null || raw === undefined) return null;
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { value };
  }

  /**
   * Run a Postgres-side array slice over the JSON array at `jsonPath` and
   * return the slice as a JS array. Bounds are 0-based with `null`
   * meaning "from the start" / "to the end". Returns `null` if the value
   * at `jsonPath` is not a JSON array (caller falls back).
   */
  async queryJsonSlice(
    path: string,
    jsonPath: string[],
    start: number | null,
    end: number | null,
  ): Promise<{ value: unknown } | null> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      return this.internalQueryJsonSlice(
        tx,
        internal,
        path,
        jsonPath,
        start,
        end,
      );
    });
  }

  private async internalQueryJsonSlice(
    tx: SqlClient,
    internal: string,
    userPath: string,
    jsonPath: string[],
    start: number | null,
    end: number | null,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<{ value: unknown } | null> {
    if (!this.excludes.empty && isExcluded(this.excludes, internal)) {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(internal, this.workspaceId);
    const params: SqlParam[] = [this.workspaceId, lt, versionId];
    let parentExpr: string;
    if (jsonPath.length === 0) {
      parentExpr = "b.content::jsonb";
    } else {
      params.push(jsonPath);
      parentExpr = "(b.content::jsonb #> $4)";
    }
    // 1-based ord from WITH ORDINALITY; jq slice [a:b] keeps indices
    // a..b-1 (0-based), i.e. 1-based ord in (a, b]. For negative bounds
    // we resolve relative to the array length here in SQL.
    const arrLen = `jsonb_array_length(${parentExpr})`;
    const startEff =
      start === null
        ? "0"
        : start < 0
          ? `GREATEST(0, ${arrLen} + (${start}))`
          : `LEAST(${arrLen}, ${start})`;
    const endEff =
      end === null
        ? arrLen
        : end < 0
          ? `GREATEST(0, ${arrLen} + (${end}))`
          : `LEAST(${arrLen}, ${end})`;
    const sliceExpr = `(SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
                       FROM jsonb_array_elements(${parentExpr}) WITH ORDINALITY AS x(value, ord)
                       WHERE ord > ${startEff} AND ord <= ${endEff})`;
    const r = await tx.query<{
      node_type: string;
      symlink_target: string | null;
      result: unknown;
    }>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type, symlink_target
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       ),
       picked AS (
         SELECT e.blob_hash, e.node_type, e.symlink_target
         FROM e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $3
         ORDER BY a.depth ASC
         LIMIT 1
       )
       SELECT picked.node_type,
              picked.symlink_target,
              CASE jsonb_typeof(${parentExpr})
                WHEN 'array' THEN ${sliceExpr}
                ELSE NULL
              END AS result
       FROM picked
       LEFT JOIN fs_blobs b
         ON b.workspace_id = $1 AND b.hash = picked.blob_hash`,
      params,
    );
    const row = r.rows[0];
    if (!row || row.node_type === "tombstone") {
      throw new FsError("ENOENT", "no such file or directory", userPath);
    }
    if (row.node_type === "symlink" && row.symlink_target) {
      if (maxDepth <= 0) {
        throw new FsError("ELOOP", "too many levels of symbolic links", userPath);
      }
      return this.internalQueryJsonSlice(
        tx,
        this.resolveLinkTargetPath(internal, row.symlink_target),
        userPath,
        jsonPath,
        start,
        end,
        maxDepth - 1,
      );
    }
    if (row.node_type === "directory") {
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, read",
        userPath,
      );
    }
    const raw = row.result;
    if (raw === null || raw === undefined) return null;
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { value };
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const internal = this.guardWrite(path);
    this.guardExcludedWrite(internal, "open", path);

    const fastOutcome = await this.tryFastWriteFile(internal, content);
    let parentKnownMissing = false;
    if (fastOutcome) {
      if (fastOutcome.status === "ok") return;
      if (fastOutcome.status === "enoent" && parentPath(internal) !== "/") {
        // Missing-parent recovery needs multiple statements, so keep it on the
        // existing transactional path.
        parentKnownMissing = true;
      } else if (fastOutcome.status === "enoent") {
        throw new FsError("ENOENT", "no such file or directory, open", path);
      } else if (fastOutcome.status === "enotdir") {
        throw new FsError("ENOTDIR", "not a directory, open", path);
      } else if (fastOutcome.status === "eisdir") {
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, open",
          path,
        );
      } else {
        throw new Error(
          `writeFile: unexpected fast-path status '${fastOutcome.status}'`,
        );
      }
    }

    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      // internalWriteFile handles missing-parent recovery itself: it tries
      // the fused upsert first, and if validation reports the parent is
      // missing it runs internalMkdir(parent, recursive: true) and retries.
      // Skipping the unconditional mkdir here saves a round-trip on the hot
      // path (parent already exists).
      await this.internalWriteFile(
        tx,
        versionId,
        internal,
        content,
        undefined,
        parentKnownMissing,
      );
    });
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const internal = this.guardWrite(path);
    this.guardExcludedWrite(internal, "open", path);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const parent = parentPath(internal);
      if (parent !== "/") {
        await this.internalMkdir(tx, versionId, parent, { recursive: true });
      }
      const existing = await this.resolveEntry(tx, internal);
      if (!existing) {
        await this.internalWriteFile(tx, versionId, internal, content);
        return;
      }
      if (existing.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, append",
          path,
        );

      const appendSize =
        typeof content === "string"
          ? new TextEncoder().encode(content).byteLength
          : content.byteLength;

      if (Number(existing.size_bytes) + appendSize > this.maxFileSize) {
        throw new Error(
          `File too large: ${
            Number(existing.size_bytes) + appendSize
          } bytes exceeds maximum of ${this.maxFileSize} bytes`,
        );
      }

      const blob = existing.blob_hash
        ? await this.getBlob(tx, existing.blob_hash)
        : null;
      const existingText = blob?.content ?? null;
      const existingBytes =
        blob?.binary_data ??
        (existingText !== null ? new TextEncoder().encode(existingText) : null);

      if (existingBytes !== null && (typeof content !== "string" || existingText === null)) {
        const appendBytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content;
        const merged = new Uint8Array(
          existingBytes.byteLength + appendBytes.byteLength,
        );
        merged.set(new Uint8Array(existingBytes), 0);
        merged.set(new Uint8Array(appendBytes), existingBytes.byteLength);
        await this.internalWriteFile(tx, versionId, internal, merged);
      } else {
        const merged = (existingText ?? "") + (content as string);
        await this.internalWriteFile(tx, versionId, internal, merged);
      }
    });
  }

  // -- Public API: Path queries -----------------------------------------------

  async exists(path: string): Promise<boolean> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntry(tx, internal);
      return node !== null;
    });
  }

  async stat(path: string): Promise<FsStat> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      return {
        ...this.statFromEntry(node),
        isSymbolicLink: false,
      };
    });
  }

  async lstat(path: string): Promise<FsStat> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntry(tx, internal);
      if (!node)
        throw new FsError("ENOENT", "no such file or directory, lstat", path);
      return this.statFromEntry(node);
    });
  }

  async realpath(path: string): Promise<string> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const resolved = await this.internalRealpath(tx, internal);
      return this.toUserPath(resolved);
    });
  }

  private async internalRealpath(
    tx: SqlClient,
    path: string,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<string> {
    const node = await this.resolveEntry(tx, path);
    if (!node)
      throw new FsError("ENOENT", "no such file or directory, realpath", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError(
          "ELOOP",
          "too many levels of symbolic links, realpath",
          path,
        );
      return this.internalRealpath(
        tx,
        this.resolveLinkTargetPath(path, node.symlink_target),
        maxDepth - 1,
      );
    }
    return ltreeToPath(node.path);
  }

  // -- Public API: Directory operations ---------------------------------------

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const internal = this.guardWrite(path);
    this.guardExcludedWrite(internal, "mkdir", path);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      if (options?.versioned) {
        const existing = await this.resolveEntry(tx, internal);
        if (existing && existing.node_type !== "directory") {
          throw new FsError("ENOTDIR", "not a directory, mkdir", path);
        }
        if (!existing) {
          await this.internalMkdir(tx, versionId, internal, {
            recursive: options.recursive,
          });
        }
        await this.ensureVersionRootInitialized(tx, internal);
        return;
      }
      await this.internalMkdir(tx, versionId, internal, options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      const realPath = ltreeToPath(node.path);
      return this.listVisibleChildNames(tx, realPath);
    });
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      const realPath = ltreeToPath(node.path);
      const children = await this.listVisibleChildren(tx, realPath);
      return children.map((c) => this.mapDirChildToDirent(c));
    });
  }

  async readdirWithStats(path: string): Promise<DirentStatEntry[]> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      const realPath = ltreeToPath(node.path);
      const children = await this.listVisibleChildren(tx, realPath);
      return children.map((c) => this.mapDirChildToStatEntry(c));
    });
  }

  async walk(path: string): Promise<WalkEntry[]> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      const realPath = ltreeToPath(node.path);
      const rows = await this.listVisibleSubtree(tx, realPath, false);
      return rows.map((r) => this.mapSubtreeToWalk(r));
    });
  }

  // -- Public API: Mutation ---------------------------------------------------

  async rm(path: string, options?: RmOptions): Promise<void> {
    const internal = this.guardWrite(path);
    this.guardExcludedWrite(internal, "rm", path);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const node = await this.resolveEntry(tx, internal);
      if (!node) {
        if (options?.force) return;
        throw new FsError("ENOENT", "no such file or directory, rm", path);
      }
      if (node.node_type === "directory") {
        const children = await this.listVisibleChildren(tx, internal);
        if (children.length > 0 && !options?.recursive) {
          throw new FsError("ENOTEMPTY", "directory not empty, rm", path);
        }
        if (options?.recursive) {
          await this.writeTombstonesForVisibleSubtree(
            tx,
            versionId,
            internal,
            true,
          );
          return;
        }
      }
      await this.writeTombstone(tx, versionId, internal);
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcInternal = this.guardRead(src);
    const destInternal = this.guardWrite(dest);
    this.guardExcludedWrite(destInternal, "cp", dest);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      await this.internalCp(tx, versionId, srcInternal, destInternal, options);
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcInternal = this.guardWrite(src);
    const destInternal = this.guardWrite(dest);
    this.guardExcludedWrite(srcInternal, "mv", src);
    this.guardExcludedWrite(destInternal, "mv", dest);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const srcPath = srcInternal;
      const destPath = destInternal;

      if (destPath.startsWith(srcPath + "/") || destPath === srcPath) {
        throw new FsError(
          "EINVAL",
          "cannot move to a subdirectory of itself, mv",
          src,
        );
      }

      const srcEntry = await this.resolveEntry(tx, srcPath);
      if (!srcEntry)
        throw new FsError("ENOENT", "no such file or directory, mv", src);

      const destParent = await this.resolveEntry(tx, parentPath(destPath));
      if (!destParent)
        throw new FsError("ENOENT", "no such file or directory, mv", dest);
      if (destParent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, mv", dest);

      const destEntry = await this.resolveEntry(tx, destPath);
      if (destEntry) {
        if (
          destEntry.node_type === "directory" &&
          srcEntry.node_type !== "directory"
        ) {
          throw new FsError(
            "EISDIR",
            "cannot overwrite directory with non-directory, mv",
            dest,
          );
        }
        if (
          destEntry.node_type !== "directory" &&
          srcEntry.node_type === "directory"
        ) {
          throw new FsError(
            "ENOTDIR",
            "cannot overwrite non-directory with directory, mv",
            dest,
          );
        }
        if (destEntry.node_type === "directory") {
          const children = await this.listVisibleChildren(tx, destPath);
          if (children.length > 0) {
            throw new FsError("ENOTEMPTY", "directory not empty, mv", dest);
          }
        }
        // Tombstone destination first.
        await this.writeTombstone(tx, versionId, destPath);
      }

      if (srcEntry.node_type === "directory") {
        await this.copyVisibleSubtreeEntries(
          tx,
          versionId,
          srcPath,
          destPath,
          true,
        );
        await this.writeTombstonesForVisibleSubtree(
          tx,
          versionId,
          srcPath,
          true,
        );
      } else {
        // single-file or symlink: insert at dest with same blob_hash/symlink_target
        await this.upsertEntry(
          tx,
          versionId,
          destPath,
          srcEntry.node_type,
          srcEntry.blob_hash,
          Number(srcEntry.size_bytes),
          srcEntry.mode,
          srcEntry.symlink_target,
        );
        await this.writeTombstone(tx, versionId, srcPath);
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error(
        `Invalid mode: ${mode} (must be integer between 0 and 4095/0o7777)`,
      );
    }
    const internal = this.guardWrite(path);
    this.guardExcludedWrite(internal, "chmod", path);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      await this.upsertEntry(
        tx,
        versionId,
        ltreeToPath(node.path),
        node.node_type,
        node.blob_hash,
        Number(node.size_bytes),
        mode,
        node.symlink_target,
      );
    });
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const internal = this.guardWrite(path);
    this.guardExcludedWrite(internal, "utimes", path);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      const lt = pathToLtree(ltreeToPath(node.path), this.workspaceId);
      // Insert/update entry at current version preserving everything but mtime.
      await tx.query(
        `INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = EXCLUDED.mtime`,
        [
          this.workspaceId,
          versionId,
          lt,
          node.blob_hash,
          node.node_type,
          node.symlink_target,
          node.mode,
          Number(node.size_bytes),
          mtime,
        ],
      );
    });
  }

  // -- Public API: Links ------------------------------------------------------

  async symlink(target: string, linkPath: string): Promise<void> {
    const internal = this.guardWrite(linkPath);
    this.guardExcludedWrite(internal, "symlink", linkPath);

    if (target.includes("\0")) {
      throw new Error("Paths cannot contain null bytes");
    }
    if (target.length > 4096) {
      throw new Error(
        "Symlink target exceeds maximum length of 4096 characters",
      );
    }

    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const parent = await this.resolveEntry(tx, parentPath(internal));
      if (!parent)
        throw new FsError(
          "ENOENT",
          "no such file or directory, symlink",
          linkPath,
        );
      if (parent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, symlink", linkPath);

      const resolvedTarget = this.resolveLinkTargetPath(internal, target);
      this.validatePathDepth(resolvedTarget);
      this.guardRootBoundary(resolvedTarget);

      const sizeBytes = new TextEncoder().encode(target).byteLength;
      await this.upsertEntry(
        tx,
        versionId,
        internal,
        "symlink",
        null,
        sizeBytes,
        0o777,
        target,
      );
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const srcInternal = this.guardRead(existingPath);
    const destInternal = this.guardWrite(newPath);
    this.guardExcludedWrite(destInternal, "link", newPath);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const srcEntry = await this.resolveEntry(tx, srcInternal);
      if (!srcEntry)
        throw new FsError(
          "ENOENT",
          "no such file or directory, link",
          existingPath,
        );
      if (srcEntry.node_type === "directory")
        throw new FsError(
          "EPERM",
          "operation not permitted, link",
          existingPath,
        );

      const parent = await this.resolveEntry(tx, parentPath(destInternal));
      if (!parent)
        throw new FsError("ENOENT", "no such file or directory, link", newPath);
      if (parent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, link", newPath);

      const existing = await this.resolveEntry(tx, destInternal);
      if (existing?.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, link",
          newPath,
        );
      if (!existing) {
        await this.validateNodeCount(tx);
      }

      // Hard link semantics: same blob, new path. (Symlinks not "linkable" via link().)
      await this.upsertEntry(
        tx,
        versionId,
        destInternal,
        srcEntry.node_type,
        srcEntry.blob_hash,
        Number(srcEntry.size_bytes),
        srcEntry.mode,
        srcEntry.symlink_target,
      );
    });
  }

  async readlink(path: string): Promise<string> {
    const internal = this.guardRead(path);
    return this.withReadOnlyWorkspace(async (tx) => {
      const node = await this.resolveEntry(tx, internal);
      if (!node)
        throw new FsError(
          "ENOENT",
          "no such file or directory, readlink",
          path,
        );
      if (node.node_type !== "symlink")
        throw new FsError("EINVAL", "invalid argument, readlink", path);
      if (node.symlink_target === null) {
        throw new Error(
          `Corrupt symlink node at '${path}': symlink_target is null`,
        );
      }
      return node.symlink_target;
    });
  }

  // -- Public API: Utility ----------------------------------------------------

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    if (base === "/") return normalizePath("/" + path);
    return normalizePath(base + "/" + path);
  }

  getAllPaths(): string[] {
    return [];
  }

  // -- Public API: Search -----------------------------------------------------

  async textSearch(
    query: string,
    opts?: { path?: string; limit?: number },
  ): Promise<SearchResult[]> {
    const scopePath = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopePath);
    const internalScope = this.toInternalPath(scopePath);
    return this.withReadOnlyWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const results = await fullTextSearch(
        tx,
        this.workspaceId,
        versionId,
        query,
        { ...opts, path: internalScope, excludes: this.excludes },
      );
      return results.map((r) => ({ ...r, path: this.toUserPath(r.path) }));
    });
  }

  async semanticSearch(
    query: string,
    opts?: { path?: string; limit?: number },
  ): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const scopePath = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopePath);
    const internalScope = this.toInternalPath(scopePath);
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withReadOnlyWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const results = await semanticSearch(
        tx,
        this.workspaceId,
        versionId,
        embedding,
        { ...opts, path: internalScope, excludes: this.excludes },
      );
      return results.map((r) => ({ ...r, path: this.toUserPath(r.path) }));
    });
  }

  async hybridSearch(
    query: string,
    opts?: {
      path?: string;
      textWeight?: number;
      vectorWeight?: number;
      limit?: number;
    },
  ): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const scopePath = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopePath);
    const internalScope = this.toInternalPath(scopePath);
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withReadOnlyWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const results = await hybridSearch(
        tx,
        this.workspaceId,
        versionId,
        query,
        embedding,
        { ...opts, path: internalScope, excludes: this.excludes },
      );
      return results.map((r) => ({ ...r, path: this.toUserPath(r.path) }));
    });
  }

  // -- Public API: Glob -------------------------------------------------------

  async glob(pattern: string, opts?: { cwd?: string }): Promise<string[]> {
    const userCwd = opts?.cwd ? normalizePath(opts.cwd) : "/";
    this.guardRead(userCwd);
    const literalPrefix = globLiteralPrefix(pattern);
    const queryScope = literalPrefix
      ? normalizePath(
          userCwd === "/" ? `/${literalPrefix}` : `${userCwd}/${literalPrefix}`,
        )
      : userCwd;
    const internalScope = this.toInternalPath(queryScope);
    const queryPlan = analyzeGlobPattern(pattern, literalPrefix);

    return this.withReadOnlyWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const scopeLtree = pathToLtree(internalScope, this.workspaceId);

      const where = [
        `e.workspace_id = $1`,
        `a.descendant_id = $2`,
        queryPlan.exact ? `e.path = $3::ltree` : `e.path <@ $3::ltree`,
      ];
      const params: SqlParam[] = [
        this.workspaceId,
        versionId,
        scopeLtree,
      ];

      if (!queryPlan.exact && queryPlan.fixedDepth !== null) {
        where.push(
          `nlevel(e.path) = nlevel($3::ltree) + ${queryPlan.fixedDepth}`,
        );
      }

      if (queryPlan.basename !== null) {
        // basename match: the encoded last label
        where.push(
          `subltree(e.path, nlevel(e.path) - 1, nlevel(e.path)) = $${params.length + 1}::ltree`,
        );
        params.push(encodeBasenameForLtree(queryPlan.basename));
      }

      const exc = this.buildExcludeClause("e.path", params.length + 1);
      where.push(exc.sql);
      params.push(...exc.params);

      const sql = `
        WITH visible AS (
          SELECT DISTINCT ON (e.path)
            e.path::text AS path,
            e.node_type
          FROM fs_entries e
          JOIN version_ancestors a
            ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
          WHERE ${where.join(" AND ")}
          ORDER BY e.path, a.depth ASC
        )
        SELECT path FROM visible WHERE node_type = 'file' ORDER BY path
      `;
      const result = await tx.query<{ path: string }>(sql, params);

      const regex = globToRegex(pattern);
      return result.rows
        .map((r) => ltreeToPath(r.path))
        .map((p) => this.toUserPath(p))
        .filter((p) => {
          const relative =
            userCwd === "/" ? p.slice(1) : p.slice(userCwd.length + 1);
          return regex.test(relative);
        });
    });
  }
}

export interface PgFileSystem extends FilesystemOpsApi<PgFileSystem> {}

export type AggregateSqlKind =
  | "length"
  | "sum"
  | "min"
  | "max"
  | "sort"
  | "unique"
  | "reverse"
  | "sort_by"
  | "min_by"
  | "max_by"
  | "group_by"
  | "to_entries"
  | "from_entries"
  | "flatten"
  | "ascii_downcase"
  | "ascii_upcase"
  | "tonumber"
  | "split"
  | "join"
  | "ltrimstr"
  | "rtrimstr"
  | "sub"
  | "gsub";

function aggregateInputType(
  kind: AggregateSqlKind,
): "array" | "object" | "string" {
  if (kind === "to_entries") return "object";
  if (
    kind === "ascii_downcase" ||
    kind === "ascii_upcase" ||
    kind === "tonumber" ||
    kind === "split" ||
    kind === "ltrimstr" ||
    kind === "rtrimstr" ||
    kind === "sub" ||
    kind === "gsub"
  ) {
    return "string";
  }
  return "array";
}

/**
 * Build the inner SQL expression that produces the aggregate result over
 * the JSON array at `parentExpr`. The outer query already wraps this with
 * a `CASE jsonb_typeof(parent) WHEN 'array' THEN ... ELSE NULL END` so the
 * caller falls back to in-Node evaluation when the value isn't an array.
 *
 * Returns SQL `NULL` for type-heterogeneous arrays where pushdown can't
 * preserve jq's ordering semantics; the caller then falls back.
 */
function aggregateSqlExpr(
  parentExpr: string,
  kind: AggregateSqlKind,
  keyParamIdx: number | null,
  stringArgIdx: number | null,
  replacementArgIdx: number | null,
  numericArg: number | undefined,
): string {
  if (kind === "ascii_downcase") {
    return `to_jsonb(lower(${parentExpr} #>> '{}'))`;
  }
  if (kind === "ascii_upcase") {
    return `to_jsonb(upper(${parentExpr} #>> '{}'))`;
  }
  if (kind === "tonumber") {
    // Validate first: only push down if the string is a parseable number;
    // otherwise return SQL NULL so the caller falls back (Node will surface
    // the right jq error).
    return `(CASE
              WHEN (${parentExpr} #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
                THEN to_jsonb((${parentExpr} #>> '{}')::numeric)
              ELSE NULL
            END)`;
  }
  if (kind === "split") {
    if (stringArgIdx === null) throw new Error("split requires stringArg");
    return `to_jsonb(string_to_array(${parentExpr} #>> '{}', $${stringArgIdx}))`;
  }
  if (kind === "join") {
    // join requires the array to contain only strings (or nulls). Type-guard
    // here so Node can handle mixed/non-string arrays.
    if (stringArgIdx === null) throw new Error("join requires stringArg");
    return `(SELECT
              CASE
                WHEN bool_and(jsonb_typeof(value) = 'string' OR jsonb_typeof(value) = 'null')
                  THEN to_jsonb(string_agg(COALESCE(value #>> '{}', ''), $${stringArgIdx}))
                ELSE NULL
              END
            FROM jsonb_array_elements(${parentExpr}))`;
  }
  if (kind === "ltrimstr") {
    if (stringArgIdx === null) throw new Error("ltrimstr requires stringArg");
    return `to_jsonb(
              CASE
                WHEN strpos(${parentExpr} #>> '{}', $${stringArgIdx}) = 1
                  THEN substring(${parentExpr} #>> '{}' FROM length($${stringArgIdx}) + 1)
                ELSE ${parentExpr} #>> '{}'
              END
            )`;
  }
  if (kind === "rtrimstr") {
    if (stringArgIdx === null) throw new Error("rtrimstr requires stringArg");
    return `to_jsonb(
              CASE
                WHEN right(${parentExpr} #>> '{}', length($${stringArgIdx})) = $${stringArgIdx}
                  THEN substring(${parentExpr} #>> '{}' FROM 1
                                 FOR length(${parentExpr} #>> '{}') - length($${stringArgIdx}))
                ELSE ${parentExpr} #>> '{}'
              END
            )`;
  }
  if (kind === "sub" || kind === "gsub") {
    if (stringArgIdx === null || replacementArgIdx === null) {
      throw new Error(`${kind} requires regex and replacement args`);
    }
    const flags = kind === "gsub" ? "g" : "";
    return `to_jsonb(regexp_replace(${parentExpr} #>> '{}', $${stringArgIdx}, $${replacementArgIdx}, '${flags}'))`;
  }
  if (kind === "to_entries") {
    return `(SELECT COALESCE(jsonb_agg(jsonb_build_object('key', k, 'value', v) ORDER BY k), '[]'::jsonb)
             FROM jsonb_each(${parentExpr}) AS x(k, v))`;
  }
  if (kind === "from_entries") {
    // Strict shape only: every element must be an object with a string
    // `key` field. Anything else (alternative names like `name` / `k`,
    // missing `value`, etc.) returns SQL NULL → caller falls back to the
    // in-Node evaluator which handles jq's full lenient behaviour.
    return `(SELECT
              CASE
                WHEN COUNT(*) = 0 THEN '{}'::jsonb
                WHEN bool_and(
                       jsonb_typeof(value) = 'object'
                       AND value ? 'key'
                       AND jsonb_typeof(value->'key') = 'string'
                     )
                  THEN jsonb_object_agg(value->>'key', value->'value')
                ELSE NULL
              END
            FROM jsonb_array_elements(${parentExpr}))`;
  }
  if (kind === "flatten") {
    // numericArg === undefined → fully recursive (jq's `flatten`).
    // numericArg === 0 → input array unchanged.
    // numericArg === N (>=1) → recurse with a "remaining" budget per row,
    //   matching jq's def `def flatten(x): reduce .[] as $i ([];
    //   if $i|type=="array" and x>0 then . + ($i|flatten(x-1)) else . + [$i] end)`.
    if (numericArg === 0) {
      return parentExpr;
    }
    if (numericArg === undefined) {
      return `(
        WITH RECURSIVE flat(elem, p) AS (
          SELECT value, ARRAY[ord]::bigint[]
          FROM jsonb_array_elements(${parentExpr}) WITH ORDINALITY AS x(value, ord)
          UNION ALL
          SELECT y.value, flat.p || y.ord
          FROM flat, jsonb_array_elements(elem) WITH ORDINALITY AS y(value, ord)
          WHERE jsonb_typeof(elem) = 'array'
        )
        SELECT COALESCE(jsonb_agg(elem ORDER BY p), '[]'::jsonb)
        FROM flat
        WHERE jsonb_typeof(elem) <> 'array'
      )`;
    }
    return `(
      WITH RECURSIVE flat(elem, p, remaining) AS (
        SELECT value, ARRAY[ord]::bigint[], ${numericArg}
        FROM jsonb_array_elements(${parentExpr}) WITH ORDINALITY AS x(value, ord)
        UNION ALL
        SELECT y.value, flat.p || y.ord, remaining - 1
        FROM flat, jsonb_array_elements(elem) WITH ORDINALITY AS y(value, ord)
        WHERE jsonb_typeof(elem) = 'array' AND remaining > 0
      )
      SELECT COALESCE(jsonb_agg(elem ORDER BY p), '[]'::jsonb)
      FROM flat
      WHERE NOT (jsonb_typeof(elem) = 'array' AND remaining > 0)
    )`;
  }
  if (kind === "length") {
    return `to_jsonb(jsonb_array_length(${parentExpr}))`;
  }
  if (kind === "reverse") {
    return `(SELECT COALESCE(jsonb_agg(value ORDER BY ord DESC), '[]'::jsonb)
             FROM jsonb_array_elements(${parentExpr}) WITH ORDINALITY AS x(value, ord))`;
  }
  if (kind === "sort" || kind === "unique") {
    const distinct = kind === "unique" ? "DISTINCT " : "";
    return `(SELECT
              CASE
                WHEN COUNT(*) = 0 THEN '[]'::jsonb
                WHEN bool_and(jsonb_typeof(value) = 'number')
                  THEN jsonb_agg(${distinct}value ORDER BY (value)::text::numeric)
                WHEN bool_and(jsonb_typeof(value) = 'string')
                  THEN jsonb_agg(${distinct}value ORDER BY (value #>> '{}'))
                ELSE NULL
              END
            FROM jsonb_array_elements(${parentExpr}))`;
  }
  if (kind === "group_by") {
    if (keyParamIdx === null) {
      throw new Error(`group_by requires a keyPath`);
    }
    const keyExpr = `(value #> $${keyParamIdx})`;
    return `(SELECT
              CASE
                WHEN COUNT(*) = 0 THEN '[]'::jsonb
                WHEN bool_and(jsonb_typeof(${keyExpr}) = 'number')
                  THEN (SELECT jsonb_agg(grp ORDER BY (group_key)::text::numeric)
                        FROM (
                          SELECT ${keyExpr} AS group_key,
                                 jsonb_agg(value ORDER BY ord) AS grp
                          FROM jsonb_array_elements(${parentExpr}) WITH ORDINALITY AS x(value, ord)
                          GROUP BY ${keyExpr}
                        ) g)
                WHEN bool_and(jsonb_typeof(${keyExpr}) = 'string')
                  THEN (SELECT jsonb_agg(grp ORDER BY (group_key #>> '{}'))
                        FROM (
                          SELECT ${keyExpr} AS group_key,
                                 jsonb_agg(value ORDER BY ord) AS grp
                          FROM jsonb_array_elements(${parentExpr}) WITH ORDINALITY AS x(value, ord)
                          GROUP BY ${keyExpr}
                        ) g)
                ELSE NULL
              END
            FROM jsonb_array_elements(${parentExpr}))`;
  }
  if (kind === "sort_by" || kind === "min_by" || kind === "max_by") {
    if (keyParamIdx === null) {
      throw new Error(`${kind} requires a keyPath`);
    }
    const keyExpr = `(value #> $${keyParamIdx})`;
    if (kind === "sort_by") {
      return `(SELECT
                CASE
                  WHEN COUNT(*) = 0 THEN '[]'::jsonb
                  WHEN bool_and(jsonb_typeof(${keyExpr}) = 'number')
                    THEN jsonb_agg(value ORDER BY (${keyExpr})::text::numeric)
                  WHEN bool_and(jsonb_typeof(${keyExpr}) = 'string')
                    THEN jsonb_agg(value ORDER BY (${keyExpr} #>> '{}'))
                  ELSE NULL
                END
              FROM jsonb_array_elements(${parentExpr}))`;
    }
    // min_by / max_by: pick a single element by key. Empty array → null.
    const direction = kind === "min_by" ? "ASC" : "DESC";
    return `(SELECT
              CASE
                WHEN (SELECT COUNT(*) FROM jsonb_array_elements(${parentExpr})) = 0
                  THEN 'null'::jsonb
                WHEN (SELECT bool_and(jsonb_typeof(${keyExpr}) = 'number')
                      FROM jsonb_array_elements(${parentExpr}) AS x(value))
                  THEN (SELECT value FROM jsonb_array_elements(${parentExpr}) AS x(value)
                        ORDER BY (${keyExpr})::text::numeric ${direction} LIMIT 1)
                WHEN (SELECT bool_and(jsonb_typeof(${keyExpr}) = 'string')
                      FROM jsonb_array_elements(${parentExpr}) AS x(value))
                  THEN (SELECT value FROM jsonb_array_elements(${parentExpr}) AS x(value)
                        ORDER BY (${keyExpr} #>> '{}') ${direction} LIMIT 1)
                ELSE NULL
              END)`;
  }
  // sum / min / max: numeric arrays only.
  const op = kind === "sum" ? "SUM" : kind === "min" ? "MIN" : "MAX";
  return `(SELECT
            CASE
              WHEN COUNT(*) = 0 THEN 'null'::jsonb
              WHEN bool_and(jsonb_typeof(value) = 'number')
                THEN to_jsonb(${op}((value)::text::numeric))
              ELSE NULL
            END
          FROM jsonb_array_elements(${parentExpr}))`;
}

installFilesystemOps(PgFileSystem.prototype);
