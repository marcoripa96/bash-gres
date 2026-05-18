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
  removeVersionRoot,
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
      get historyRetention() {
        return self.historyRetention;
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
          // See note on `rawDb` in `FsStateBase`: opaque to the core, fed back
          // verbatim into whichever constructor the adapter exposes.
          db: self.rawDb as SqlClient,
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
          // See note on `rawDb` in `FsStateBase`.
          db: self.rawDb as SqlClient,
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
        `WITH ins AS (
           INSERT INTO fs_entries (workspace_id, version_id, path, node_type, mode)
           VALUES ($1, $2, $3::ltree, 'directory', $4)
           ON CONFLICT (workspace_id, version_id, path) DO NOTHING
           RETURNING 1
         ),
         version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $2 AND EXISTS (SELECT 1 FROM ins)
           RETURNING 1
         )
         SELECT 1 FROM ins`,
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
      const deleteVersionRoot = options?.deleteVersionRoot === true;
      if (deleteVersionRoot && !options?.recursive) {
        throw new FsError(
          "EINVAL",
          "deleteVersionRoot requires recursive, rm",
          path,
        );
      }
      if (
        deleteVersionRoot &&
        (internal === "/" || internal === this.versionRootPath)
      ) {
        throw new FsError(
          "EINVAL",
          "cannot delete active version root, rm",
          path,
        );
      }

      const versionId = await this.getCurrentVersionId(tx);
      const node = await this.resolveEntry(tx, internal);
      if (!node) {
        if (deleteVersionRoot) {
          const removed = await removeVersionRoot(
            this[filesystemOpsContext](),
            tx,
            internal,
          );
          if (removed || options?.force) return;
        }
        if (options?.force) return;
        throw new FsError("ENOENT", "no such file or directory, rm", path);
      }
      if (node.node_type === "directory") {
        if (options?.recursive) {
          await this.writeTombstonesForVisibleSubtree(
            tx,
            versionId,
            internal,
            true,
          );
          if (deleteVersionRoot) {
            const removed = await removeVersionRoot(
              this[filesystemOpsContext](),
              tx,
              internal,
            );
            if (!removed) {
              throw new FsError(
                "ENOTVERSIONED",
                "not a versioned directory, rm",
                path,
              );
            }
          }
          return;
        }
        const children = await this.listVisibleChildren(tx, internal);
        if (children.length > 0) {
          throw new FsError("ENOTEMPTY", "directory not empty, rm", path);
        }
      } else if (deleteVersionRoot) {
        throw new FsError("ENOTDIR", "not a directory, rm", path);
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
        `WITH version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $2
           RETURNING 1
         )
         INSERT INTO fs_entries
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

installFilesystemOps(PgFileSystem.prototype);
