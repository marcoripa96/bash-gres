import { randomUUID, createHash } from "crypto";
import type {
  SqlClient,
  PgFileSystemOptions,
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
} from "./types.js";
import { FsError, SqlError } from "./types.js";
import { readonlySqlClient } from "./readonly.js";
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

// -- Row shapes -------------------------------------------------------------

interface EntryRow {
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

interface BlobRow {
  hash: Uint8Array;
  content: string | null;
  binary_data: Uint8Array | null;
  size_bytes: number;
}

interface DirChildRow {
  path: string;
  node_type: string;
  blob_hash: Uint8Array | null;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
}

interface SubtreeRow extends DirChildRow {
  depth_in_subtree: number;
}

/**
 * Internal representation of an entry's data, used by batch primitives
 * (diff/merge/cherry-pick/revert/detach) to apply pre-fetched rows back into
 * `fs_entries` without re-reading or re-hashing content. Mirrors the public
 * `EntryShape` from `types.ts`, but holds a raw `Uint8Array` blob hash for
 * direct binding to PostgreSQL.
 */
interface InternalEntryShape {
  type: "file" | "directory" | "symlink";
  blobHash: Uint8Array | null;
  symlinkTarget: string | null;
  mode: number;
  sizeBytes: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_DEPTH = 50;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_SYMLINK_DEPTH = 16;
const DEFAULT_MAX_CP_NODES = 10_000;

const DEFAULT_VERSION = "main";
const TOMBSTONE = "tombstone";

// -- PgFileSystem -----------------------------------------------------------

export class PgFileSystem {
  private client: SqlClient;
  private rawDb: SqlClient;
  readonly workspaceId: string;
  /**
   * Mutable backing for the public `version` getter. Internal code that needs
   * to change the instance's label after a successful commit (e.g. `renameVersion()`)
   * writes here.
   */
  private versionLabel: string;
  readonly permissions: { read: boolean; write: boolean };
  private maxFileSize: number;
  private maxReadSize: number | undefined;
  private maxFiles: number;
  private maxDepth: number;
  private maxSymlinkDepth: number;
  private maxCpNodes: number;
  private statementTimeoutMs: number;
  private embed?: (text: string) => Promise<number[]>;
  private embeddingDimensions?: number;
  private rootDir: string;
  private readonly baseOptions: PgFileSystemOptions;
  private cachedVersionId: number | null = null;
  private blobsHasEmbeddingCache: boolean | null = null;
  /**
   * When non-null, this instance is a transaction-bound facade. All `withWorkspace()`
   * calls on the facade run `fn(txClient)` directly instead of opening a new
   * transaction. The outer `transaction()` call has already wired up RLS
   * (`app.workspace_id`) and `statement_timeout` on this client.
   */
  private txClient: SqlClient | null = null;

  constructor(options: PgFileSystemOptions) {
    const perms = {
      read: options.permissions?.read ?? true,
      write: options.permissions?.write ?? true,
    };
    this.permissions = perms;
    this.rawDb = options.db;
    this.client = perms.write ? options.db : readonlySqlClient(options.db);
    this.workspaceId = options.workspaceId ?? randomUUID();
    this.versionLabel = options.version ?? DEFAULT_VERSION;
    if (this.versionLabel.length === 0) {
      throw new Error("version must be a non-empty string");
    }
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxReadSize = options.maxReadSize;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxSymlinkDepth =
      options.maxSymlinkDepth ?? DEFAULT_MAX_SYMLINK_DEPTH;
    this.maxCpNodes = options.maxCpNodes ?? DEFAULT_MAX_CP_NODES;
    this.statementTimeoutMs =
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.embed = options.embed;
    this.embeddingDimensions = options.embeddingDimensions;
    this.rootDir = normalizePath(options.rootDir ?? "/");
    this.baseOptions = {
      ...options,
      workspaceId: this.workspaceId,
    };
  }

  /**
   * The version label this instance is bound to. Backed by a mutable private field
   * so that operations like `renameVersion()` can update the label after commit.
   */
  get version(): string {
    return this.versionLabel;
  }

  async init(): Promise<void> {
    await this.withWorkspace(async (tx) => {
      const versionId = await this.ensureVersion(tx);
      const rootLtree = pathToLtree("/", this.workspaceId);
      await tx.query(
        `INSERT INTO fs_entries (workspace_id, version_id, path, node_type, mode)
         VALUES ($1, $2, $3::ltree, 'directory', $4)
         ON CONFLICT (workspace_id, version_id, path) DO NOTHING`,
        [this.workspaceId, versionId, rootLtree, 0o755],
      );

      if (this.rootDir !== "/") {
        await this.internalMkdir(tx, versionId, this.rootDir, {
          recursive: true,
        });
      }
    });
  }

  // -- Transaction wrapper (sets RLS context + timeout) -----------------------

  /**
   * Open a transaction on `client`, install the per-tx workspace + timeout
   * settings, and run `fn`. Used by both `withWorkspace()` and `transaction()`.
   */
  private runInWorkspace<T>(
    client: SqlClient,
    fn: (tx: SqlClient) => Promise<T>,
  ): Promise<T> {
    return client.transaction(async (tx) => {
      await tx.query(
        `SELECT
           set_config('app.workspace_id', $1, true),
           set_config('statement_timeout', $2, true)`,
        [this.workspaceId, String(this.statementTimeoutMs)],
      );
      return fn(tx);
    });
  }

  /**
   * Run `fn` inside a workspace-scoped transaction. If this instance is a
   * transaction-bound facade (i.e. `txClient` is set), reuse the open
   * transaction directly. Maps PostgreSQL "read-only transaction" violations
   * (SQLSTATE 25006) into the public `EPERM` `FsError`.
   */
  private async withWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    try {
      if (this.txClient) {
        return await fn(this.txClient);
      }
      return await this.runInWorkspace(this.client, fn);
    } catch (e) {
      if (e instanceof SqlError && e.code === "25006") {
        throw new FsError("EPERM", "read-only file system", "/");
      }
      throw e;
    }
  }

  // -- Version resolution -----------------------------------------------------

  private async getCurrentVersionId(tx: SqlClient): Promise<number> {
    if (this.cachedVersionId !== null) return this.cachedVersionId;
    const r = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND label = $2
       LIMIT 1`,
      [this.workspaceId, this.versionLabel],
    );
    if (r.rows.length === 0) {
      throw new Error(
        `Version '${this.versionLabel}' does not exist in workspace '${this.workspaceId}'. Call init() or fork() first.`,
      );
    }
    this.cachedVersionId = Number(r.rows[0].id);
    return this.cachedVersionId;
  }

  private async ensureVersion(tx: SqlClient): Promise<number> {
    if (this.cachedVersionId !== null) return this.cachedVersionId;
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND label = $2
       LIMIT 1`,
      [this.workspaceId, this.versionLabel],
    );
    if (existing.rows.length > 0) {
      this.cachedVersionId = Number(existing.rows[0].id);
      return this.cachedVersionId;
    }
    const created = await tx.query<{ id: number }>(
      `INSERT INTO fs_versions (workspace_id, label, parent_version_id)
       VALUES ($1, $2, NULL)
       RETURNING id`,
      [this.workspaceId, this.versionLabel],
    );
    const id = Number(created.rows[0]!.id);
    await tx.query(
      `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
       VALUES ($1, $2, $2, 0)
       ON CONFLICT DO NOTHING`,
      [this.workspaceId, id],
    );
    this.cachedVersionId = id;
    return id;
  }

  /** Resolve a label to a version ID in this workspace, or null if missing. */
  private async getVersionIdByLabel(
    tx: SqlClient,
    label: string,
  ): Promise<number | null> {
    const r = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND label = $2
       LIMIT 1`,
      [this.workspaceId, label],
    );
    return r.rows.length > 0 ? Number(r.rows[0]!.id) : null;
  }

  private async requireVersionIdByLabel(
    tx: SqlClient,
    label: string,
  ): Promise<number> {
    const id = await this.getVersionIdByLabel(tx, label);
    if (id === null) {
      throw new Error(
        `Version '${label}' does not exist in workspace '${this.workspaceId}'.`,
      );
    }
    return id;
  }

  /**
   * Acquire transaction-scoped advisory locks for the given version IDs in
   * deterministic order (sorted ascending) to avoid deadlocks. Released at end
   * of transaction.
   */
  private async lockVersions(
    tx: SqlClient,
    versionIds: number[],
  ): Promise<void> {
    if (versionIds.length === 0) return;
    const sorted = [...new Set(versionIds)].sort((a, b) => a - b);
    for (const id of sorted) {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2::int)`, [
        this.workspaceId,
        id,
      ]);
    }
  }

  // -- Visibility resolution --------------------------------------------------

  /**
   * Find the visible entry at `posixPath` for the current version, walking the
   * version-ancestors closure to the closest ancestor that has a row at this path.
   * Returns null if not visible (no ancestor has a row, or the closest hit is a tombstone).
   */
  private async resolveEntry(
    tx: SqlClient,
    posixPath: string,
  ): Promise<EntryRow | null> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(posixPath, this.workspaceId);
    const r = await tx.query<EntryRow>(
      `SELECT e.workspace_id, e.version_id, e.path::text AS path, e.blob_hash,
              e.node_type, e.symlink_target, e.mode, e.size_bytes, e.mtime, e.created_at
       FROM version_ancestors a
       INNER JOIN LATERAL (
         SELECT * FROM fs_entries
         WHERE workspace_id = $1
           AND version_id = a.ancestor_id
           AND path = $2::ltree
         LIMIT 1
       ) e ON true
       WHERE a.workspace_id = $1
         AND a.descendant_id = $3
       ORDER BY a.depth ASC
       LIMIT 1`,
      [this.workspaceId, lt, versionId],
    );
    const row = r.rows[0];
    if (!row || row.node_type === TOMBSTONE) return null;
    return row;
  }

  private async resolveEntryFollowSymlink(
    tx: SqlClient,
    posixPath: string,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<EntryRow> {
    const node = await this.resolveEntry(tx, posixPath);
    if (!node)
      throw new FsError("ENOENT", "no such file or directory", posixPath);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError(
          "ELOOP",
          "too many levels of symbolic links",
          posixPath,
        );
      return this.resolveEntryFollowSymlink(
        tx,
        this.resolveLinkTargetPath(posixPath, node.symlink_target),
        maxDepth - 1,
      );
    }
    return node;
  }

  private async getBlob(
    tx: SqlClient,
    hash: Uint8Array,
  ): Promise<BlobRow | null> {
    const r = await tx.query<BlobRow>(
      `SELECT hash, content, binary_data, size_bytes
       FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    return r.rows[0] ?? null;
  }

  // -- Visible directory listing ---------------------------------------------

  private async listVisibleChildren(
    tx: SqlClient,
    parentPosix: string,
  ): Promise<DirChildRow[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(parentPosix, this.workspaceId);
    const r = await tx.query<DirChildRow>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes,
           e.mtime
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND e.path != $3::ltree
           AND nlevel(e.path) = nlevel($3::ltree) + 1
         ORDER BY e.path, a.depth ASC
       )
       SELECT * FROM visible WHERE node_type != $4 ORDER BY path`,
      [this.workspaceId, versionId, lt, TOMBSTONE],
    );
    return r.rows;
  }

  private async listVisibleSubtree(
    tx: SqlClient,
    rootPosix: string,
    includeRoot = false,
  ): Promise<SubtreeRow[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const filter = includeRoot ? "" : "AND e.path != $3::ltree";
    const r = await tx.query<SubtreeRow>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes,
           e.mtime,
           nlevel(e.path) - nlevel($3::ltree) AS depth_in_subtree
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           ${filter}
         ORDER BY e.path, a.depth ASC
       )
       SELECT * FROM visible WHERE node_type != $4 ORDER BY path`,
      [this.workspaceId, versionId, lt, TOMBSTONE],
    );
    return r.rows;
  }

  // -- Symlink target resolution ---------------------------------------------

  private resolveLinkTargetPath(linkPath: string, target: string): string {
    let resolved: string;
    if (target.startsWith("/")) {
      resolved = normalizePath(this.rootDir + "/" + target);
    } else {
      resolved = normalizePath(parentPath(linkPath) + "/" + target);
    }
    this.guardRootBoundary(resolved);
    return resolved;
  }

  // -- Validation -------------------------------------------------------------

  private validateFileSize(content: string | Uint8Array): void {
    const size =
      typeof content === "string"
        ? new TextEncoder().encode(content).byteLength
        : content.byteLength;
    if (size > this.maxFileSize) {
      throw new Error(
        `File too large: ${size} bytes exceeds maximum of ${this.maxFileSize} bytes`,
      );
    }
  }

  private async validateNodeCount(tx: SqlClient): Promise<void> {
    const versionId = await this.getCurrentVersionId(tx);
    const r = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT DISTINCT ON (e.path) e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1 AND a.descendant_id = $2
         ORDER BY e.path, a.depth ASC
       ) v WHERE node_type != $3`,
      [this.workspaceId, versionId, TOMBSTONE],
    );
    if (r.rows[0] && r.rows[0].count >= this.maxFiles) {
      throw new Error(
        `Node limit reached: ${this.maxFiles} nodes per workspace`,
      );
    }
  }

  private validatePathDepth(path: string): void {
    const depth = path.split("/").filter(Boolean).length;
    if (depth > this.maxDepth) {
      throw new Error(
        `Path too deep: ${depth} levels exceeds maximum of ${this.maxDepth}`,
      );
    }
  }

  // -- Path translation & access guards ---------------------------------------

  private toInternalPath(userPath: string): string {
    const p = normalizePath(userPath);
    if (this.rootDir === "/") return p;
    return p === "/" ? this.rootDir : normalizePath(this.rootDir + p);
  }

  private toUserPath(internalPath: string): string {
    if (this.rootDir === "/") return internalPath;
    if (internalPath === this.rootDir) return "/";
    return internalPath.slice(this.rootDir.length);
  }

  private guardRead(userPath: string): string {
    return this.toInternalPath(normalizePath(userPath));
  }

  private guardWrite(userPath: string): string {
    return this.toInternalPath(normalizePath(userPath));
  }

  private guardRootBoundary(internalPath: string): void {
    if (this.rootDir === "/") return;
    if (
      internalPath !== this.rootDir &&
      !internalPath.startsWith(this.rootDir + "/")
    ) {
      throw new FsError(
        "EACCES",
        "symlink target outside root boundary",
        this.toUserPath(internalPath),
      );
    }
  }

  // -- Mappers ---------------------------------------------------------------

  private mapDirChildToDirent(row: DirChildRow): DirentEntry {
    const userPath = ltreeToPath(row.path);
    return {
      name: fileName(userPath),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
    };
  }

  private mapDirChildToStatEntry(row: DirChildRow): DirentStatEntry {
    const userPath = ltreeToPath(row.path);
    return {
      name: fileName(userPath),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
      symlinkTarget: row.symlink_target,
    };
  }

  private mapSubtreeToWalk(row: SubtreeRow): WalkEntry {
    const userPath = ltreeToPath(row.path);
    return {
      path: this.toUserPath(userPath),
      name: fileName(userPath),
      depth: Number(row.depth_in_subtree),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
      symlinkTarget: row.symlink_target,
    };
  }

  private statFromEntry(row: EntryRow): FsStat {
    return {
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
    };
  }

  // -- Internal write paths --------------------------------------------------

  private async upsertBlob(
    tx: SqlClient,
    hash: Uint8Array,
    content: string | Uint8Array,
    sizeBytes: number,
    embedding: number[] | null,
  ): Promise<void> {
    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;

    if (embedding !== null) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await tx.query(
        `INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (workspace_id, hash) DO UPDATE SET
           embedding = COALESCE(fs_blobs.embedding, EXCLUDED.embedding)`,
        [this.workspaceId, hash, textContent, binaryData, sizeBytes, embeddingStr],
      );
    } else {
      await tx.query(
        `INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, hash) DO NOTHING`,
        [this.workspaceId, hash, textContent, binaryData, sizeBytes],
      );
    }
  }

  private async upsertEntry(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    nodeType: string,
    blobHash: Uint8Array | null,
    sizeBytes: number,
    mode: number,
    symlinkTarget: string | null,
  ): Promise<void> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    await tx.query(
      `INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type,
          symlink_target, mode, size_bytes, mtime)
       VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, now())
       ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
         blob_hash = EXCLUDED.blob_hash,
         node_type = EXCLUDED.node_type,
         symlink_target = EXCLUDED.symlink_target,
         mode = EXCLUDED.mode,
         size_bytes = EXCLUDED.size_bytes,
         mtime = now()`,
      [
        this.workspaceId,
        versionId,
        lt,
        blobHash,
        nodeType,
        symlinkTarget,
        mode,
        sizeBytes,
      ],
    );
  }

  private async writeTombstone(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
  ): Promise<void> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    await tx.query(
      `INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type, mode, size_bytes, mtime)
       VALUES ($1, $2, $3::ltree, NULL, $4, 0, 0, now())
       ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
         blob_hash = NULL,
         node_type = $4,
         symlink_target = NULL,
         mode = 0,
         size_bytes = 0,
         mtime = now()`,
      [this.workspaceId, versionId, lt, TOMBSTONE],
    );
  }

  /**
   * Apply a pre-fetched entry shape to the destination version's `fs_entries`.
   * Used by batch operations (merge, cherry-pick, revert, detach) to copy
   * within the same workspace without rehashing content. A `null` shape writes
   * a tombstone.
   */
  private async writeEntryShape(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    shape: InternalEntryShape | null,
  ): Promise<void> {
    if (shape === null) {
      await this.writeTombstone(tx, versionId, posixPath);
      return;
    }
    await this.upsertEntry(
      tx,
      versionId,
      posixPath,
      shape.type,
      shape.blobHash,
      shape.sizeBytes,
      shape.mode,
      shape.symlinkTarget,
    );
  }

  private async internalWriteFile(
    tx: SqlClient,
    versionId: number,
    path: string,
    content: string | Uint8Array,
    precomputedEmbedding?: number[] | null,
  ): Promise<void> {
    this.validateFileSize(content);
    this.validatePathDepth(path);

    const parentPosix = parentPath(path);
    const parent = await this.resolveEntry(tx, parentPosix);
    if (!parent)
      throw new FsError("ENOENT", "no such file or directory, open", path);
    if (parent.node_type !== "directory")
      throw new FsError("ENOTDIR", "not a directory, open", path);

    const existing = await this.resolveEntry(tx, path);
    if (existing?.node_type === "directory")
      throw new FsError(
        "EISDIR",
        "illegal operation on a directory, open",
        path,
      );

    if (!existing) {
      await this.validateNodeCount(tx);
    }

    const isText = typeof content === "string";
    const bytes = isText
      ? new TextEncoder().encode(content)
      : (content as Uint8Array);
    const sizeBytes = bytes.byteLength;
    const hash = sha256(bytes);

    let embedding: number[] | null = null;
    if (precomputedEmbedding !== undefined) {
      embedding = precomputedEmbedding;
    } else if (
      isText &&
      this.embed &&
      content.length > 0 &&
      (await this.blobsHasEmbedding(tx))
    ) {
      embedding = await this.maybeEmbed(tx, hash, content);
    }

    await this.upsertBlob(tx, hash, content, sizeBytes, embedding);
    await this.upsertEntry(
      tx,
      versionId,
      path,
      "file",
      hash,
      sizeBytes,
      0o644,
      null,
    );
  }

  private async blobsHasEmbedding(tx: SqlClient): Promise<boolean> {
    if (this.blobsHasEmbeddingCache !== null)
      return this.blobsHasEmbeddingCache;
    const r = await tx.query<{ has_col: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'fs_blobs' AND column_name = 'embedding'
       ) AS has_col`,
    );
    this.blobsHasEmbeddingCache = r.rows[0]?.has_col ?? false;
    return this.blobsHasEmbeddingCache;
  }

  private async maybeEmbed(
    tx: SqlClient,
    hash: Uint8Array,
    content: string,
  ): Promise<number[] | null> {
    if (!this.embed) return null;
    const existing = await tx.query<{ has_embedding: boolean }>(
      `SELECT (embedding IS NOT NULL) AS has_embedding
       FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    if (existing.rows[0]?.has_embedding) return null;
    const embedding = await this.embed(content);
    validateEmbedding(embedding, this.embeddingDimensions);
    return embedding;
  }

  // -- Internal mkdir ---------------------------------------------------------

  private async internalMkdir(
    tx: SqlClient,
    versionId: number,
    path: string,
    options?: MkdirOptions,
  ): Promise<void> {
    this.validatePathDepth(path);
    const recursive = options?.recursive ?? false;

    if (recursive) {
      const segments = path.split("/").filter(Boolean);
      let current = "/";
      for (const segment of segments) {
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        const visible = await this.resolveEntry(tx, current);
        if (visible) {
          if (visible.node_type !== "directory") {
            throw new FsError("ENOTDIR", "not a directory, mkdir", current);
          }
          // already a visible directory; nothing to do
          continue;
        }
        await this.upsertEntry(
          tx,
          versionId,
          current,
          "directory",
          null,
          0,
          0o755,
          null,
        );
      }
    } else {
      const existing = await this.resolveEntry(tx, path);
      if (existing)
        throw new FsError("EEXIST", "file already exists, mkdir", path);
      const parent = await this.resolveEntry(tx, parentPath(path));
      if (!parent)
        throw new FsError("ENOENT", "no such file or directory, mkdir", path);
      if (parent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, mkdir", path);
      await this.upsertEntry(
        tx,
        versionId,
        path,
        "directory",
        null,
        0,
        0o755,
        null,
      );
    }
  }

  // -- Internal cp ------------------------------------------------------------

  private async internalCp(
    tx: SqlClient,
    versionId: number,
    src: string,
    dest: string,
    options?: CpOptions,
    counter?: { count: number },
  ): Promise<void> {
    const nodeCounter = counter ?? { count: 0 };

    if (dest.startsWith(src + "/") || dest === src) {
      throw new FsError(
        "EINVAL",
        "cannot copy to a subdirectory of itself, cp",
        src,
      );
    }

    const srcEntry = await this.resolveEntry(tx, src);
    if (!srcEntry)
      throw new FsError("ENOENT", "no such file or directory, cp", src);

    nodeCounter.count++;
    if (nodeCounter.count > this.maxCpNodes) {
      throw new Error(
        `cp: too many nodes (exceeds limit of ${this.maxCpNodes})`,
      );
    }

    if (srcEntry.node_type === "directory") {
      if (!options?.recursive) {
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, cp",
          src,
        );
      }
      await this.internalMkdir(tx, versionId, dest, { recursive: true });
      const children = await this.listVisibleChildren(tx, src);
      for (const child of children) {
        const name = fileName(ltreeToPath(child.path));
        const srcChild = src === "/" ? `/${name}` : `${src}/${name}`;
        const destChild = dest === "/" ? `/${name}` : `${dest}/${name}`;
        await this.internalCp(
          tx,
          versionId,
          srcChild,
          destChild,
          options,
          nodeCounter,
        );
      }
      return;
    }

    if (srcEntry.node_type === "symlink") {
      // Recreate the symlink at dest. validatePathDepth happens via guard upstream;
      // re-validate target boundary.
      this.validatePathDepth(dest);
      const target = srcEntry.symlink_target ?? "";
      const sizeBytes = new TextEncoder().encode(target).byteLength;
      await this.upsertEntry(
        tx,
        versionId,
        dest,
        "symlink",
        null,
        sizeBytes,
        0o777,
        target,
      );
      return;
    }

    // file: share the blob (same blob_hash), insert new entry at dest
    if (srcEntry.blob_hash) {
      // confirm parent dir exists
      const parentEntry = await this.resolveEntry(tx, parentPath(dest));
      if (!parentEntry)
        throw new FsError("ENOENT", "no such file or directory, cp", dest);
      if (parentEntry.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, cp", dest);
      const existing = await this.resolveEntry(tx, dest);
      if (existing?.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, cp",
          dest,
        );
      if (!existing) {
        await this.validateNodeCount(tx);
      }
      await this.upsertEntry(
        tx,
        versionId,
        dest,
        "file",
        srcEntry.blob_hash,
        Number(srcEntry.size_bytes),
        srcEntry.mode,
        null,
      );
    } else {
      // Empty file (no blob_hash). Create empty entry.
      await this.internalWriteFile(tx, versionId, dest, "", null);
    }
  }

  // -- Public API: File I/O ---------------------------------------------------

  async readFile(
    path: string,
    _options?: { encoding?: string | null } | string,
  ): Promise<string> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, read",
          path,
        );

      const size = Number(node.size_bytes);
      if (this.maxReadSize !== undefined && size > this.maxReadSize) {
        throw new FsError(
          "E2BIG",
          `file too large to read (${size} bytes, max ${this.maxReadSize}). Use readFileRange with { offset, limit } to read in chunks`,
          path,
        );
      }

      if (!node.blob_hash) return "";
      const blob = await this.getBlob(tx, node.blob_hash);
      if (!blob) return "";
      if (blob.content !== null) return blob.content;
      if (blob.binary_data !== null)
        return new TextDecoder().decode(blob.binary_data);
      return "";
    });
  }

  async readFileRange(
    path: string,
    options?: ReadFileRangeOptions,
  ): Promise<string> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, read",
          path,
        );
      if (!node.blob_hash) return "";

      const sqlOffset = (options?.offset ?? 0) + 1;
      const sqlLimit = options?.limit;

      const textExpr =
        sqlLimit !== undefined ? `substr(content, $3, $4)` : `substr(content, $3)`;
      const binaryExpr =
        sqlLimit !== undefined
          ? `substring(binary_data FROM $3 FOR $4)`
          : `substring(binary_data FROM $3)`;

      const params: (string | number | Uint8Array)[] = [
        this.workspaceId,
        node.blob_hash,
        sqlOffset,
      ];
      if (sqlLimit !== undefined) params.push(sqlLimit);

      const result = await tx.query<{
        chunk_text: string | null;
        chunk_binary: Uint8Array | null;
      }>(
        `SELECT ${textExpr} AS chunk_text,
                ${binaryExpr} AS chunk_binary
         FROM fs_blobs
         WHERE workspace_id = $1 AND hash = $2
         LIMIT 1`,
        params,
      );

      const chunk = result.rows[0];
      if (!chunk) return "";
      if (chunk.chunk_text !== null) return chunk.chunk_text;
      if (chunk.chunk_binary !== null)
        return new TextDecoder().decode(chunk.chunk_binary);
      return "";
    });
  }

  async readFileLines(
    path: string,
    options?: ReadFileLinesOptions,
  ): Promise<ReadFileLinesResult> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, read",
          path,
        );

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
      const end = limit !== undefined ? start + limit - 1 : null;

      if (!node.blob_hash) return { content: "", total: 0 };

      const sliceExpr = end !== null ? "lines[$3:$4]" : "lines[$3:]";
      const params: (string | number | Uint8Array)[] = [
        this.workspaceId,
        node.blob_hash,
        start,
      ];
      if (end !== null) params.push(end);

      const result = await tx.query<{
        chunk: string | null;
        total: number | null;
        is_binary: boolean;
      }>(
        `WITH raw AS (
           SELECT string_to_array(content, E'\n') AS arr,
                  (content LIKE '%' || E'\n') AS has_trail,
                  (content IS NULL AND binary_data IS NOT NULL) AS is_binary
           FROM fs_blobs
           WHERE workspace_id = $1 AND hash = $2
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
         SELECT array_to_string(${sliceExpr}, E'\n') AS chunk,
                coalesce(array_length(lines, 1), 0) AS total,
                is_binary
         FROM parts`,
        params,
      );

      const row = result.rows[0];
      if (!row) return { content: "", total: 0 };
      if (row.is_binary) {
        throw new FsError(
          "EINVAL",
          "readFileLines is text-only; use readFileRange for binary files",
          path,
        );
      }
      return { content: row.chunk ?? "", total: row.total ?? 0 };
    });
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, read",
          path,
        );
      if (!node.blob_hash) return new Uint8Array(0);
      const blob = await this.getBlob(tx, node.blob_hash);
      if (!blob) return new Uint8Array(0);
      if (blob.binary_data !== null) return blob.binary_data;
      if (blob.content !== null) return new TextEncoder().encode(blob.content);
      return new Uint8Array(0);
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const internal = this.guardWrite(path);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const parent = parentPath(internal);
      if (parent !== "/") {
        await this.internalMkdir(tx, versionId, parent, { recursive: true });
      }
      await this.internalWriteFile(tx, versionId, internal, content);
    });
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const internal = this.guardWrite(path);
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
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntry(tx, internal);
      return node !== null;
    });
  }

  async stat(path: string): Promise<FsStat> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      return {
        ...this.statFromEntry(node),
        isSymbolicLink: false,
      };
    });
  }

  async lstat(path: string): Promise<FsStat> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntry(tx, internal);
      if (!node)
        throw new FsError("ENOENT", "no such file or directory, lstat", path);
      return this.statFromEntry(node);
    });
  }

  async realpath(path: string): Promise<string> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
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
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      await this.internalMkdir(tx, versionId, internal, options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveEntryFollowSymlink(tx, internal);
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      const realPath = ltreeToPath(node.path);
      const children = await this.listVisibleChildren(tx, realPath);
      return children.map((c) => fileName(ltreeToPath(c.path)));
    });
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
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
    return this.withWorkspace(async (tx) => {
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
    return this.withWorkspace(async (tx) => {
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
          const subtree = await this.listVisibleSubtree(tx, internal, true);
          // Tombstone all visible paths (including root) at current version.
          // Order doesn't matter because tombstones don't reference each other.
          for (const row of subtree) {
            const userPath = ltreeToPath(row.path);
            await this.writeTombstone(tx, versionId, userPath);
          }
          return;
        }
      }
      await this.writeTombstone(tx, versionId, internal);
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcInternal = this.guardRead(src);
    const destInternal = this.guardWrite(dest);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      await this.internalCp(tx, versionId, srcInternal, destInternal, options);
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcInternal = this.guardWrite(src);
    const destInternal = this.guardWrite(dest);
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
        // Move all visible descendants: tombstone each old path, insert new entry at translated path.
        const subtree = await this.listVisibleSubtree(tx, srcPath, true);
        // Insert new entries first, then tombstone old paths. Order matters
        // because src and dest may overlap (already guarded above, but be safe).
        for (const row of subtree) {
          const oldPath = ltreeToPath(row.path);
          const suffix = oldPath === srcPath ? "" : oldPath.slice(srcPath.length);
          const newPath = destPath + suffix;
          await this.upsertEntry(
            tx,
            versionId,
            newPath,
            row.node_type,
            row.blob_hash,
            Number(row.size_bytes),
            row.mode,
            row.symlink_target,
          );
        }
        for (const row of subtree) {
          const oldPath = ltreeToPath(row.path);
          await this.writeTombstone(tx, versionId, oldPath);
        }
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
    return this.withWorkspace(async (tx) => {
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
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const results = await fullTextSearch(
        tx,
        this.workspaceId,
        versionId,
        query,
        { ...opts, path: internalScope },
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
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const results = await semanticSearch(
        tx,
        this.workspaceId,
        versionId,
        embedding,
        { ...opts, path: internalScope },
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
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const results = await hybridSearch(
        tx,
        this.workspaceId,
        versionId,
        query,
        embedding,
        { ...opts, path: internalScope },
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

    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const scopeLtree = pathToLtree(internalScope, this.workspaceId);

      const where = [
        `e.workspace_id = $1`,
        `a.descendant_id = $2`,
        queryPlan.exact ? `e.path = $3::ltree` : `e.path <@ $3::ltree`,
      ];
      const params: (string | number)[] = [
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

  // -- Versioning -------------------------------------------------------------

  /**
   * Run `fn` inside a single database transaction. `fn` receives a
   * transaction-bound `PgFileSystem` facade for the same workspace, version,
   * permissions, limits, and rootDir. Multiple operations on the facade share
   * the same transaction: if `fn` throws or rejects, every write rolls back;
   * if `fn` returns, the transaction commits and the return value is the
   * `transaction()` result.
   *
   * Re-entrant: calling `transaction()` on a facade that is already inside an
   * outer transaction reuses that outer transaction (no nested savepoints).
   *
   * Read-only instances still produce a read-only transaction; writes inside
   * `fn` raise `FsError(EPERM)`.
   *
   * The facade should not be retained after `fn` resolves — its underlying
   * SQL transaction has closed and further calls will fail.
   */
  async transaction<T>(fn: (tx: PgFileSystem) => Promise<T>): Promise<T> {
    if (this.txClient) {
      // Already inside a transaction: nested calls share the outer tx.
      return fn(this);
    }
    try {
      return await this.runInWorkspace(this.client, async (sqlTx) => {
        const facade = this.createTxFacade(sqlTx);
        return fn(facade);
      });
    } catch (e) {
      if (e instanceof SqlError && e.code === "25006") {
        throw new FsError("EPERM", "read-only file system", "/");
      }
      throw e;
    }
  }

  /**
   * Build a transaction-bound `PgFileSystem` facade that shares this instance's
   * configuration and runs every operation against the supplied SQL transaction
   * client.
   */
  private createTxFacade(sqlTx: SqlClient): PgFileSystem {
    const facade = new PgFileSystem({
      ...this.baseOptions,
      db: this.rawDb,
      // Use the live label, not the construction-time one, so a facade created
      // after a successful renameVersion() still points at the right version.
      version: this.versionLabel,
    });
    facade.txClient = sqlTx;
    facade.cachedVersionId = this.cachedVersionId;
    return facade;
  }

  async fork(newVersion: string): Promise<PgFileSystem> {
    if (!newVersion || newVersion.length === 0) {
      throw new Error("fork: newVersion must be a non-empty string");
    }
    if (newVersion === this.versionLabel) {
      throw new Error(
        `fork: newVersion must differ from current version '${this.versionLabel}'`,
      );
    }

    await this.withWorkspace(async (tx) => {
      const parentId = await this.getCurrentVersionId(tx);
      const existing = await tx.query(
        `SELECT 1 FROM fs_versions
         WHERE workspace_id = $1 AND label = $2`,
        [this.workspaceId, newVersion],
      );
      if (existing.rows.length > 0) {
        throw new Error(`fork: version '${newVersion}' already exists`);
      }
      const created = await tx.query<{ id: number }>(
        `INSERT INTO fs_versions (workspace_id, label, parent_version_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [this.workspaceId, newVersion, parentId],
      );
      const newId = Number(created.rows[0]!.id);
      await tx.query(
        `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
         SELECT $1, $2, ancestor_id, depth + 1
         FROM version_ancestors
         WHERE workspace_id = $1 AND descendant_id = $3`,
        [this.workspaceId, newId, parentId],
      );
      await tx.query(
        `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
         VALUES ($1, $2, $2, 0)`,
        [this.workspaceId, newId],
      );
    });

    const child = new PgFileSystem({
      ...this.baseOptions,
      db: this.rawDb,
      version: newVersion,
    });
    if (this.txClient) {
      // Stay in the outer transaction so subsequent writes through the child
      // are visible to other facade-bound operations and roll back together.
      child.txClient = this.txClient;
    }
    return child;
  }

  async listVersions(): Promise<string[]> {
    return this.withWorkspace(async (tx) => {
      const r = await tx.query<{ label: string }>(
        `SELECT label FROM fs_versions
         WHERE workspace_id = $1
         ORDER BY label`,
        [this.workspaceId],
      );
      return r.rows.map((row) => row.label);
    });
  }

  async deleteVersion(version: string): Promise<void> {
    if (version === this.versionLabel) {
      throw new Error(
        `deleteVersion: cannot delete current version '${version}'`,
      );
    }
    await this.withWorkspace(async (tx) => {
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM fs_versions
         WHERE workspace_id = $1 AND label = $2
         LIMIT 1`,
        [this.workspaceId, version],
      );
      if (r.rows.length === 0) return;
      const targetId = Number(r.rows[0]!.id);
      await this.deleteVersionById(tx, targetId);
    });
  }

  private async deleteVersionById(
    tx: SqlClient,
    versionId: number,
  ): Promise<void> {
    const children = await tx.query(
      `SELECT 1 FROM fs_versions
       WHERE workspace_id = $1 AND parent_version_id = $2
       LIMIT 1`,
      [this.workspaceId, versionId],
    );
    if (children.rows.length > 0) {
      throw new Error(
        `deleteVersion: version has descendants; delete or squash them first`,
      );
    }

    // Advisory lock to serialize against concurrent writers of the same blobs
    // in this workspace. The lock is released at end of transaction.
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), $2::int)`,
      [this.workspaceId, versionId],
    );

    // Capture blob hashes that this version's entries referenced.
    const freed = await tx.query<{ blob_hash: Uint8Array }>(
      `DELETE FROM fs_entries
       WHERE workspace_id = $1 AND version_id = $2
       RETURNING blob_hash`,
      [this.workspaceId, versionId],
    );
    const candidates = new Map<string, Uint8Array>();
    for (const row of freed.rows) {
      if (row.blob_hash) {
        candidates.set(bytesKey(row.blob_hash), row.blob_hash);
      }
    }

    await tx.query(
      `DELETE FROM version_ancestors
       WHERE workspace_id = $1 AND (descendant_id = $2 OR ancestor_id = $2)`,
      [this.workspaceId, versionId],
    );
    await tx.query(
      `DELETE FROM fs_versions
       WHERE workspace_id = $1 AND id = $2`,
      [this.workspaceId, versionId],
    );

    if (candidates.size > 0) {
      // GC orphan blobs: only those previously owned by this version and now unreferenced.
      for (const hash of candidates.values()) {
        await tx.query(
          `DELETE FROM fs_blobs
           WHERE workspace_id = $1 AND hash = $2
             AND NOT EXISTS (
               SELECT 1 FROM fs_entries
               WHERE workspace_id = $1 AND blob_hash = $2
             )`,
          [this.workspaceId, hash],
        );
      }
    }
  }

  async dispose(): Promise<void> {
    await this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      await this.deleteVersionById(tx, versionId);
    });
    this.cachedVersionId = null;
  }
}

// -- Free helpers -----------------------------------------------------------

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function bytesKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Semantic equality for entry shapes. Compares `type`, `blob_hash`,
 * `symlink_target`, and `mode`. Ignores `mtime`, `size_bytes`, `created_at`.
 * `size_bytes` is derived from blob/symlink content; comparing it would be
 * redundant with `blob_hash` and `symlink_target`.
 */
function entryShapeEqual(
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

function blobHashEqual(
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

// path-encoding's `encodeLabel` is not exported here; mirror the encoding for a single basename.
// The encoded last label of an ltree is exactly `encodeLabel(basename)`. We re-implement it
// inline to avoid leaking another export from path-encoding.
function encodeBasenameForLtree(name: string): string {
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

function globToRegex(pattern: string): RegExp {
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

function globLiteralPrefix(pattern: string): string | null {
  const segments = pattern.split("/");
  const prefix: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") break;
    if (/[?*{]/.test(segment)) break;
    prefix.push(segment);
  }
  return prefix.length > 0 ? prefix.join("/") : null;
}

function analyzeGlobPattern(
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
