import { randomUUID, createHash } from "crypto";
import type {
  SqlClient,
  SqlParam,
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
  EntryShape,
  NodeType,
  VersionDiffEntry,
  RenameVersionResult,
  PromoteResult,
  MergeStrategy,
  MergeResult,
  ConflictEntry,
  WorkspaceUsage,
  WorkspaceUsageOptions,
} from "./types.js";
import { FsError, FsQuotaError, SqlError } from "./types.js";
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
 * direct binding to PostgreSQL. `mtime` is the source row's mtime; the write
 * path stamps `now()` regardless and ignores this field.
 */
interface InternalEntryShape {
  type: "file" | "directory" | "symlink";
  blobHash: Uint8Array | null;
  symlinkTarget: string | null;
  mode: number;
  sizeBytes: number;
  mtime: Date;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_DEPTH = 50;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_SYMLINK_DEPTH = 16;
const DEFAULT_MAX_CP_NODES = 10_000;

const DEFAULT_VERSION = "main";
const TOMBSTONE = "tombstone";
const DIFF_DEFAULT_BATCH_SIZE = 500;
const DIFF_MAX_BATCH_SIZE = 5000;

interface DiffRow {
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

interface UsageRow {
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
  private maxWorkspaceBytes: number | undefined;
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
  /**
   * Hooks queued by tx-bound facade methods (e.g. `renameVersion()`) to apply
   * instance-state mutations on the originating instance only after the outer
   * transaction commits. Set on the facade by `transaction()`; never mutated on
   * a top-level instance.
   */
  private postCommitHooks: Array<() => void> | null = null;
  /**
   * The instance that produced this facade via `createTxFacade()`. Used so that
   * post-commit hooks (such as label updates) can target the surviving outer
   * instance rather than the transient facade.
   */
  private originInstance: PgFileSystem | null = null;

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
    this.maxWorkspaceBytes = options.maxWorkspaceBytes;
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

  async getUsage(options?: WorkspaceUsageOptions): Promise<WorkspaceUsage> {
    const scopeUser = options?.path ? normalizePath(options.path) : "/";
    this.guardRead(scopeUser);
    const scopeInternal = this.toInternalPath(scopeUser);
    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const scopeLtree = pathToLtree(scopeInternal, this.workspaceId);
      const r = await tx.query<UsageRow>(
        `WITH visible_raw AS (
           SELECT DISTINCT ON (e.path)
             e.node_type,
             e.size_bytes,
             e.blob_hash
           FROM fs_entries e
           JOIN version_ancestors a
             ON a.workspace_id = e.workspace_id
            AND a.ancestor_id = e.version_id
           WHERE e.workspace_id = $1
             AND a.descendant_id = $2
             AND e.path <@ $4::ltree
           ORDER BY e.path, a.depth ASC
         ),
         visible AS (
           SELECT node_type, size_bytes, blob_hash
           FROM visible_raw
           WHERE node_type != $3
         ),
         referenced_blobs AS (
           SELECT DISTINCT blob_hash
           FROM visible
           WHERE node_type = 'file' AND blob_hash IS NOT NULL
         )
         SELECT
           (SELECT COUNT(*) FROM fs_versions WHERE workspace_id = $1) AS versions,
           (SELECT COUNT(*) FROM fs_entries WHERE workspace_id = $1) AS entry_rows,
           (SELECT COUNT(*) FROM fs_entries WHERE workspace_id = $1 AND node_type = $3) AS tombstone_rows,
           (SELECT COUNT(*) FROM fs_blobs WHERE workspace_id = $1) AS blob_count,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM fs_blobs WHERE workspace_id = $1) AS stored_blob_bytes,
           (SELECT COALESCE(SUM(b.size_bytes), 0)
            FROM referenced_blobs rb
            JOIN fs_blobs b ON b.workspace_id = $1 AND b.hash = rb.blob_hash) AS referenced_blob_bytes,
           (SELECT COUNT(*) FROM visible) AS visible_nodes,
           (SELECT COUNT(*) FROM visible WHERE node_type = 'file') AS visible_files,
           (SELECT COUNT(*) FROM visible WHERE node_type = 'directory') AS visible_directories,
           (SELECT COUNT(*) FROM visible WHERE node_type = 'symlink') AS visible_symlinks,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM visible) AS logical_bytes`,
        [this.workspaceId, versionId, TOMBSTONE, scopeLtree],
      );
      const row = r.rows[0]!;
      return {
        workspaceId: this.workspaceId,
        version: this.versionLabel,
        path: scopeUser,
        logicalBytes: Number(row.logical_bytes),
        referencedBlobBytes: Number(row.referenced_blob_bytes),
        storedBlobBytes: Number(row.stored_blob_bytes),
        blobCount: Number(row.blob_count),
        versions: Number(row.versions),
        entryRows: Number(row.entry_rows),
        tombstoneRows: Number(row.tombstone_rows),
        visibleNodes: Number(row.visible_nodes),
        visibleFiles: Number(row.visible_files),
        visibleDirectories: Number(row.visible_directories),
        visibleSymlinks: Number(row.visible_symlinks),
        limits: {
          maxFiles: this.maxFiles,
          maxFileSize: this.maxFileSize,
          ...(this.maxWorkspaceBytes !== undefined ? { maxWorkspaceBytes: this.maxWorkspaceBytes } : {}),
        },
      };
    });
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

  /**
   * Find the lowest common ancestor (in the version graph) of `idA` and `idB`,
   * or `null` if they have no common ancestor. "Lowest" = smallest sum of
   * depths across the two ancestor chains, which is the version closest to
   * both endpoints. Used by `merge()` for three-way classification.
   */
  private async findLCA(
    tx: SqlClient,
    idA: number,
    idB: number,
  ): Promise<number | null> {
    const r = await tx.query<{ ancestor_id: number }>(
      `SELECT a1.ancestor_id
       FROM version_ancestors a1
       JOIN version_ancestors a2
         ON a2.workspace_id = a1.workspace_id
        AND a2.ancestor_id = a1.ancestor_id
       WHERE a1.workspace_id = $1
         AND a1.descendant_id = $2
         AND a2.descendant_id = $3
       ORDER BY a1.depth + a2.depth ASC
       LIMIT 1`,
      [this.workspaceId, idA, idB],
    );
    return r.rows.length > 0 ? Number(r.rows[0]!.ancestor_id) : null;
  }

  /**
   * Count of visible (non-tombstone) entries across the entire workspace at
   * `versionId`. Used by batch operations to validate `maxFiles` once before
   * committing many writes, instead of re-checking after every write.
   */
  private async globalVisibleCount(
    tx: SqlClient,
    versionId: number,
  ): Promise<number> {
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
    return Number(r.rows[0]?.count ?? 0);
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
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, mode, size_bytes, mtime, created_at
         FROM fs_entries
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
       SELECT path, node_type, blob_hash, symlink_target, mode, size_bytes, mtime
       FROM visible WHERE node_type != $4 ORDER BY path`,
      [this.workspaceId, versionId, lt, TOMBSTONE],
    );
    return r.rows;
  }

  /**
   * Fetch every visible (non-tombstone) entry under `scopeLtree` for
   * `versionId`, keyed by internal POSIX path. Used by batch primitives
   * (merge/cherryPick/revert) to do classification entirely in TypeScript
   * once each side's tree is in memory.
   */
  private async fetchVisibleEntryMap(
    tx: SqlClient,
    versionId: number,
    scopeLtree: string,
  ): Promise<Map<string, InternalEntryShape>> {
    const r = await tx.query<{
      path: string;
      node_type: string;
      blob_hash: Uint8Array | null;
      symlink_target: string | null;
      mode: number;
      size_bytes: number | string;
      mtime: Date;
    }>(
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
         ORDER BY e.path, a.depth ASC
       )
       SELECT path, node_type, blob_hash, symlink_target, mode, size_bytes, mtime
       FROM visible WHERE node_type != $4`,
      [this.workspaceId, versionId, scopeLtree, TOMBSTONE],
    );
    const map = new Map<string, InternalEntryShape>();
    for (const row of r.rows) {
      map.set(ltreeToPath(row.path), {
        type: row.node_type as NodeType,
        blobHash: row.blob_hash,
        symlinkTarget: row.symlink_target,
        mode: row.mode,
        sizeBytes: Number(row.size_bytes),
        mtime: new Date(row.mtime),
      });
    }
    return map;
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
       SELECT path, node_type, blob_hash, symlink_target, mode, size_bytes,
              mtime, depth_in_subtree
       FROM visible WHERE node_type != $4 ORDER BY path`,
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
    userPath: string,
  ): Promise<void> {
    await this.validateWorkspaceBytes(tx, hash, sizeBytes, userPath);

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

  private async validateWorkspaceBytes(
    tx: SqlClient,
    hash: Uint8Array,
    sizeBytes: number,
    userPath: string,
  ): Promise<void> {
    if (this.maxWorkspaceBytes === undefined) return;

    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1), -1)`, [
      this.workspaceId,
    ]);

    const existing = await tx.query(
      `SELECT 1 FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    if (existing.rows.length > 0) return;

    const usage = await tx.query<{ stored_blob_bytes: number | string }>(
      `SELECT COALESCE(SUM(size_bytes), 0) AS stored_blob_bytes
       FROM fs_blobs
       WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    const current = Number(usage.rows[0]?.stored_blob_bytes ?? 0);
    if (current + sizeBytes > this.maxWorkspaceBytes) {
      throw new FsQuotaError(
        "workspace byte quota exceeded",
        userPath,
        this.maxWorkspaceBytes,
        current,
        sizeBytes,
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
    embedding: number[] | null = null,
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

    await this.upsertBlob(
      tx,
      hash,
      content,
      sizeBytes,
      embedding,
      this.toUserPath(path),
    );
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

  private async prepareEmbedding(
    content: string | Uint8Array,
  ): Promise<number[] | null> {
    if (typeof content !== "string" || content.length === 0 || !this.embed) {
      return null;
    }
    if (!(await this.withWorkspace((tx) => this.blobsHasEmbedding(tx)))) {
      return null;
    }
    const embedding = await this.embed(content);
    validateEmbedding(embedding, this.embeddingDimensions);
    return embedding;
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

  private async getBlobEmbedding(
    tx: SqlClient,
    hash: Uint8Array,
  ): Promise<number[] | null> {
    if (!(await this.blobsHasEmbedding(tx))) return null;
    const result = await tx.query<{ embedding: string | null }>(
      `SELECT embedding::text AS embedding
       FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    const embedding = result.rows[0]?.embedding;
    return embedding ? this.parseEmbeddingText(embedding) : null;
  }

  private parseEmbeddingText(text: string): number[] {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      throw new Error(`Invalid vector value returned by database: ${text}`);
    }
    const body = trimmed.slice(1, -1);
    const embedding = body.length === 0
      ? []
      : body.split(",").map((value) => Number(value.trim()));
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
    this.validateFileSize(content);
    this.validatePathDepth(internal);
    const embedding = await this.prepareEmbedding(content);

    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const parent = parentPath(internal);
      if (parent !== "/") {
        await this.internalMkdir(tx, versionId, parent, { recursive: true });
      }
      await this.internalWriteFile(tx, versionId, internal, content, embedding);
    });
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const internal = this.guardWrite(path);
    this.validateFileSize(content);
    this.validatePathDepth(internal);

    // Pre-embed outside any transaction so we never hold a connection idle
    // during the embedding RPC. Used only when this call creates a new file
    // (in which case appendFile is equivalent to writeFile). When appending
    // to an existing file we keep the existing embedding rather than
    // re-embed merged content; callers needing a fresh embedding should
    // writeFile instead.
    const newFileEmbedding = await this.prepareEmbedding(content);

    return this.withWorkspace(async (tx) => {
      const versionId = await this.getCurrentVersionId(tx);
      const parent = parentPath(internal);
      if (parent !== "/") {
        await this.internalMkdir(tx, versionId, parent, { recursive: true });
      }
      const existing = await this.resolveEntry(tx, internal);
      if (!existing) {
        await this.internalWriteFile(
          tx,
          versionId,
          internal,
          content,
          newFileEmbedding,
        );
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
        await this.internalWriteFile(tx, versionId, internal, merged, null);
      } else {
        const merged = (existingText ?? "") + (content as string);
        const existingEmbedding = existing.blob_hash
          ? await this.getBlobEmbedding(tx, existing.blob_hash)
          : null;
        await this.internalWriteFile(
          tx,
          versionId,
          internal,
          merged,
          existingEmbedding,
        );
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
    const hooks: Array<() => void> = [];
    try {
      const value = await this.runInWorkspace(this.client, async (sqlTx) => {
        const facade = this.createTxFacade(sqlTx, hooks);
        return fn(facade);
      });
      // Outer tx committed — apply queued post-commit state mutations on this
      // instance. If the tx threw, we skip these and the instance's state is
      // unchanged.
      for (const hook of hooks) hook();
      return value;
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
  private createTxFacade(
    sqlTx: SqlClient,
    postCommitHooks: Array<() => void>,
  ): PgFileSystem {
    const facade = new PgFileSystem({
      ...this.baseOptions,
      db: this.rawDb,
      // Use the live label, not the construction-time one, so a facade created
      // after a successful renameVersion() still points at the right version.
      version: this.versionLabel,
    });
    facade.txClient = sqlTx;
    facade.cachedVersionId = this.cachedVersionId;
    facade.postCommitHooks = postCommitHooks;
    facade.originInstance = this;
    return facade;
  }

  /**
   * Compare this version's visible tree to `other`'s visible tree at the same
   * workspace, and return the path-level differences.
   *
   * `before` is this version's entry; `after` is `other`'s. Reading "what
   * changes if current became `other`?" gives the natural interpretation.
   * Equality is over `node_type`, `blob_hash`, `mode`, and `symlink_target`;
   * `mtime`, `size_bytes`, and `created_at` are not part of the comparison.
   *
   * If `opts.path` is provided, the comparison is scoped to that user path
   * and its descendants. Tombstones in either version present as `null` for
   * that side.
   */
  async diff(
    other: string,
    opts?: { path?: string },
  ): Promise<VersionDiffEntry[]> {
    if (other.length === 0) {
      throw new Error("diff: other must be a non-empty version label");
    }
    const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopeUser);
    const internalScope = this.toInternalPath(scopeUser);

    return this.withWorkspace(async (tx) => {
      const ourId = await this.getCurrentVersionId(tx);
      const theirId = await this.requireVersionIdByLabel(tx, other);
      const scopeLtree = pathToLtree(internalScope, this.workspaceId);
      const { entries } = await this.fetchDiff(tx, ourId, theirId, scopeLtree, null);
      return entries;
    });
  }

  /**
   * Streaming diff with keyset pagination by encoded ltree path. Each batch is
   * fetched in its own short transaction; the stream is not snapshot-isolated
   * across the whole iteration. Use `diff()` for an in-memory snapshot.
   */
  async *diffStream(
    other: string,
    opts?: { path?: string; batchSize?: number },
  ): AsyncIterable<VersionDiffEntry> {
    if (other.length === 0) {
      throw new Error("diffStream: other must be a non-empty version label");
    }
    const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopeUser);
    const internalScope = this.toInternalPath(scopeUser);
    const requested = opts?.batchSize ?? DIFF_DEFAULT_BATCH_SIZE;
    const batchSize = Math.max(1, Math.min(requested, DIFF_MAX_BATCH_SIZE));

    let cursor: string | null = null;
    while (true) {
      const { entries, lastLtree } = await this.withWorkspace(async (tx) => {
        const ourId = await this.getCurrentVersionId(tx);
        const theirId = await this.requireVersionIdByLabel(tx, other);
        const scopeLtree = pathToLtree(internalScope, this.workspaceId);
        return this.fetchDiff(tx, ourId, theirId, scopeLtree, {
          cursor,
          limit: batchSize,
        });
      });
      for (const entry of entries) yield entry;
      if (entries.length < batchSize) return;
      cursor = lastLtree;
    }
  }

  /**
   * Run the actual diff SQL: two visible-entry CTEs, FULL OUTER JOIN by path,
   * filter out equal rows. Returns rows already mapped to `VersionDiffEntry`
   * plus the encoded-ltree path of the last row, suitable as the next
   * keyset-pagination cursor.
   */
  private async fetchDiff(
    tx: SqlClient,
    ourId: number,
    theirId: number,
    scopeLtree: string,
    page: { cursor: string | null; limit: number } | null,
  ): Promise<{ entries: VersionDiffEntry[]; lastLtree: string | null }> {
    const params: SqlParam[] = [this.workspaceId, ourId, theirId, scopeLtree];
    let cursorClause = "";
    let limitClause = "";
    if (page) {
      if (page.cursor !== null) {
        params.push(page.cursor);
        cursorClause = `AND path > $${params.length}::ltree`;
      }
      params.push(page.limit);
      limitClause = `LIMIT $${params.length}`;
    }
    const sql = `
      WITH ours_raw AS (
        SELECT DISTINCT ON (e.path)
          e.path,
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
          AND e.path <@ $4::ltree
        ORDER BY e.path, a.depth ASC
      ),
      ours AS (SELECT * FROM ours_raw WHERE node_type != 'tombstone'),
      theirs_raw AS (
        SELECT DISTINCT ON (e.path)
          e.path,
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
          AND a.descendant_id = $3
          AND e.path <@ $4::ltree
        ORDER BY e.path, a.depth ASC
      ),
      theirs AS (SELECT * FROM theirs_raw WHERE node_type != 'tombstone')
      SELECT
        path::text AS path,
        ours.node_type AS o_type,
        ours.blob_hash AS o_hash,
        ours.symlink_target AS o_link,
        ours.mode AS o_mode,
        ours.size_bytes AS o_size,
        ours.mtime AS o_mtime,
        theirs.node_type AS t_type,
        theirs.blob_hash AS t_hash,
        theirs.symlink_target AS t_link,
        theirs.mode AS t_mode,
        theirs.size_bytes AS t_size,
        theirs.mtime AS t_mtime
      FROM ours
      FULL OUTER JOIN theirs USING (path)
      WHERE (
        ours.node_type IS NULL
        OR theirs.node_type IS NULL
        OR ours.node_type != theirs.node_type
        OR ours.mode != theirs.mode
        OR ours.symlink_target IS DISTINCT FROM theirs.symlink_target
        OR ours.blob_hash IS DISTINCT FROM theirs.blob_hash
      )
      ${cursorClause}
      ORDER BY path
      ${limitClause}
    `;

    const result = await tx.query<DiffRow>(sql, params);
    const entries: VersionDiffEntry[] = [];
    for (const row of result.rows) {
      const before = mapDiffSide(
        row.o_type,
        row.o_hash,
        row.o_link,
        row.o_mode,
        row.o_size,
        row.o_mtime,
      );
      const after = mapDiffSide(
        row.t_type,
        row.t_hash,
        row.t_link,
        row.t_mode,
        row.t_size,
        row.t_mtime,
      );
      entries.push({
        path: this.toUserPath(ltreeToPath(row.path)),
        change: classifyDiffChange(before, after),
        before,
        after,
      });
    }
    const lastLtree =
      result.rows.length > 0 ? result.rows[result.rows.length - 1]!.path : null;
    return { entries, lastLtree };
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

  /**
   * Detach the current version from its ancestor chain so it stops depending
   * on any former ancestor for paths it can currently see.
   *
   * Visible contents of the current version and of every descendant are
   * preserved byte-for-byte. After commit, `parent_version_id` of the current
   * version is `NULL`, closure rows from the current subtree to versions
   * outside the subtree are gone, and former ancestors can be deleted (subject
   * to their own descendant checks) without changing what the current version
   * shows.
   *
   * Steps inside one transaction:
   *   1. Resolve the current version `V` and the set of all descendants of `V`
   *      (the "subtree", inclusive of `V`).
   *   2. Lock subtree version rows in `fs_versions` (FOR UPDATE) and acquire
   *      advisory mutation locks for the same IDs in deterministic order.
   *   3. Materialize visible non-tombstone entries from `V`'s former ancestors
   *      into `V`'s own `fs_entries` rows. Existing rows on `V` win
   *      (`ON CONFLICT DO NOTHING`).
   *   4. Set `V.parent_version_id = NULL`.
   *   5. Delete closure rows from any subtree descendant to ancestors outside
   *      the subtree. Closure rows internal to the subtree are kept.
   *   6. Drop tombstones at `V`. Now that `V` has no ancestors and no
   *      descendant inherits from those ancestors via `V`, tombstones at `V`
   *      cannot hide anything.
   *
   * Idempotent: detaching an already-root version is a no-op modulo dropping
   * any pre-existing tombstones at `V` (which serve no purpose on a root).
   *
   * Cost: O(visible paths in `V`) + O(versions in `V`'s subtree). Honors
   * `statementTimeoutMs`; large subtrees should raise the timeout.
   */
  async detach(): Promise<void> {
    return this.withWorkspace(async (tx) => {
      await this.internalDetach(tx);
    });
  }

  private async internalDetach(tx: SqlClient): Promise<void> {
    const versionId = await this.getCurrentVersionId(tx);

    // 1. Subtree IDs (including V itself, via the self-row in version_ancestors).
    const sub = await tx.query<{ id: number }>(
      `SELECT descendant_id AS id
       FROM version_ancestors
       WHERE workspace_id = $1 AND ancestor_id = $2
       ORDER BY descendant_id`,
      [this.workspaceId, versionId],
    );
    const subtreeIds = sub.rows.map((r) => Number(r.id));

    // 2. Lock fs_versions rows, then acquire advisory locks. Both in sorted
    //    order to match other graph mutators.
    if (subtreeIds.length > 0) {
      await tx.query(
        `SELECT id FROM fs_versions
         WHERE workspace_id = $1 AND id = ANY($2::bigint[])
         ORDER BY id
         FOR UPDATE`,
        [this.workspaceId, subtreeIds],
      );
      await this.lockVersions(tx, subtreeIds);
    }

    // 3. Materialize V's visible non-tombstone entries into V's own rows.
    //    The DISTINCT ON returns the closest ancestor row per path; tombstones
    //    at depth 0+ correctly mask ancestor files (the outer
    //    `node_type <> 'tombstone'` filter then drops them). Rows already
    //    owned by V (`src.version_id = V`) are skipped so we never INSERT a
    //    duplicate of V's own row.
    await tx.query(
      `INSERT INTO fs_entries (
         workspace_id, version_id, path, blob_hash, node_type,
         symlink_target, mode, size_bytes, mtime, created_at
       )
       SELECT
         $1, $2,
         src.path, src.blob_hash, src.node_type,
         src.symlink_target, src.mode, src.size_bytes, src.mtime, now()
       FROM (
         SELECT DISTINCT ON (e.path)
                e.path, e.blob_hash, e.node_type, e.symlink_target,
                e.mode, e.size_bytes, e.mtime, e.version_id
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
         ORDER BY e.path, a.depth ASC
       ) src
       WHERE src.version_id <> $2
         AND src.node_type <> 'tombstone'
       ON CONFLICT (workspace_id, version_id, path) DO NOTHING`,
      [this.workspaceId, versionId],
    );

    // 4. Detach V from its parent in the version graph.
    await tx.query(
      `UPDATE fs_versions
       SET parent_version_id = NULL
       WHERE workspace_id = $1 AND id = $2`,
      [this.workspaceId, versionId],
    );

    // 5. Remove closure rows from anywhere in the subtree to ancestors that
    //    fall outside it. Within-subtree rows (including each version's self
    //    row at depth 0) are preserved.
    if (subtreeIds.length > 0) {
      await tx.query(
        `DELETE FROM version_ancestors
         WHERE workspace_id = $1
           AND descendant_id = ANY($2::bigint[])
           AND NOT (ancestor_id = ANY($2::bigint[]))`,
        [this.workspaceId, subtreeIds],
      );
    }

    // 6. Tombstones on V no longer mask anything: V has no ancestors, and
    //    descendants no longer reach V's former ancestors through V.
    await tx.query(
      `DELETE FROM fs_entries
       WHERE workspace_id = $1
         AND version_id = $2
         AND node_type = 'tombstone'`,
      [this.workspaceId, versionId],
    );
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

  /**
   * Rename the current version's label. With `swap: true`, atomically move an
   * existing label out of the way (renaming the displaced version to a
   * generated `<newLabel>-prev-YYYYMMDDHHMMSS-<id>` label) and assign that
   * label to the current version. The current version's ID does not change,
   * so `cachedVersionId` is preserved.
   *
   * If `newLabel` already equals the current label, the call is a no-op and
   * returns `{ label: newLabel }` without touching the database.
   *
   * If `newLabel` is taken by another version and `swap !== true`, throws.
   *
   * The instance's `version` getter is updated only after the surrounding
   * SQL commits. When called inside `transaction(fn)`, the outer instance's
   * label is updated only if the outer transaction commits successfully; a
   * rollback leaves it at the prior label.
   */
  async renameVersion(
    newLabel: string,
    opts?: { swap?: boolean },
  ): Promise<RenameVersionResult> {
    if (!newLabel || newLabel.length === 0) {
      throw new Error("renameVersion: newLabel must be a non-empty string");
    }
    if (newLabel === this.versionLabel) {
      return { label: newLabel };
    }
    const swap = opts?.swap ?? false;
    const result = await this.withWorkspace((tx) =>
      this.internalRenameVersion(tx, newLabel, swap),
    );
    // Update the active label on this instance. For top-level calls the SQL
    // has already committed; for tx-bound facades it has not, but the facade
    // is single-shot and is discarded when the outer transaction resolves.
    // The `cachedVersionId` is left intact: the version ID didn't move.
    this.versionLabel = result.label;
    if (this.txClient && this.originInstance && this.postCommitHooks) {
      const origin = this.originInstance;
      const committed = result.label;
      this.postCommitHooks.push(() => {
        origin.versionLabel = committed;
      });
    }
    return result;
  }

  private async internalRenameVersion(
    tx: SqlClient,
    newLabel: string,
    swap: boolean,
  ): Promise<RenameVersionResult> {
    const currentId = await this.getCurrentVersionId(tx);

    // Lock the target label row (if any) so a concurrent rename can't race
    // between our existence check and the UPDATEs below.
    const targetRows = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND label = $2
       FOR UPDATE`,
      [this.workspaceId, newLabel],
    );

    if (targetRows.rows.length === 0) {
      await this.lockVersions(tx, [currentId]);
      try {
        await tx.query(
          `UPDATE fs_versions SET label = $3
           WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, currentId, newLabel],
        );
      } catch (e) {
        throw mapVersionLabelUniqueViolation(e, newLabel);
      }
      return { label: newLabel };
    }

    const targetId = Number(targetRows.rows[0]!.id);
    if (targetId === currentId) {
      // The label already belongs to us (e.g. a stale cachedVersionId path);
      // no DB change needed.
      return { label: newLabel };
    }

    if (!swap) {
      throw new Error(
        `renameVersion: label '${newLabel}' is already used by another version. Pass { swap: true } to displace it.`,
      );
    }

    await this.lockVersions(tx, [currentId, targetId]);

    const displacedLabel = generatePrevLabel(newLabel, targetId);
    try {
      await tx.query(
        `UPDATE fs_versions SET label = $3
         WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, targetId, displacedLabel],
      );
    } catch (e) {
      throw mapVersionLabelUniqueViolation(e, displacedLabel);
    }
    try {
      await tx.query(
        `UPDATE fs_versions SET label = $3
         WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, currentId, newLabel],
      );
    } catch (e) {
      throw mapVersionLabelUniqueViolation(e, newLabel);
    }
    return { label: newLabel, displacedLabel };
  }

  /**
   * Promote the current version to a label, materializing it as a self-owning
   * version, swapping any existing holder out of the way, and optionally
   * deleting that previous holder. The whole sequence is one transaction:
   * `detach()` -> `renameVersion(label, { swap: true })` -> optional
   * `deleteVersion(displacedLabel)`.
   *
   * If `dropPrevious` is true and the displaced version still has descendants,
   * the delete fails and the entire promotion rolls back.
   */
  async promoteTo(
    label: string,
    opts?: { dropPrevious?: boolean },
  ): Promise<PromoteResult> {
    if (!label || label.length === 0) {
      throw new Error("promoteTo: label must be a non-empty string");
    }
    const dropPrevious = opts?.dropPrevious ?? false;
    return this.transaction(async (tx) => {
      await tx.detach();
      const renamed = await tx.renameVersion(label, { swap: true });
      if (dropPrevious && renamed.displacedLabel) {
        await tx.deleteVersion(renamed.displacedLabel);
      }
      return {
        label: renamed.label,
        displacedLabel: dropPrevious ? undefined : renamed.displacedLabel,
        droppedPrevious: Boolean(dropPrevious && renamed.displacedLabel),
      };
    });
  }

  /**
   * Apply path-level changes from `source` into the current version using a
   * three-way comparison against the LCA. Equality is over `node_type`,
   * `blob_hash`, `mode`, and `symlink_target` (mtime/size_bytes ignored).
   *
   * Classification (one rule covers the whole conflict matrix):
   *
   *   - `ours == theirs` (semantically): skip (no-op).
   *   - else `base == ours`: only theirs changed -> apply theirs.
   *   - else `base == theirs`: only ours changed -> keep ours.
   *   - else: conflict.
   *
   * `null` (deleted / never-existed) compares like any other value, so the
   * deletion rows in the proposal's matrix collapse cleanly: `(- - X)` ->
   * `base == ours` -> apply (add); `(X X -)` -> `base == ours` -> apply
   * tombstone; `(X - X)` -> `base == theirs` -> skip; etc.
   *
   * Strategies on conflict:
   *
   *   - `fail` (default): no writes; conflicts returned, applied/skipped both
   *     empty.
   *   - `ours`: keep destination, conflicts still reported, path goes in
   *     `skipped`.
   *   - `theirs`: apply source, conflicts still reported (so callers can see
   *     the override), path goes in `applied`.
   *
   * Filters: `paths` matches each entry as either an exact path or a path
   * prefix (so a directory entry pulls in its descendants visible in any of
   * base/ours/theirs); `pathScope` restricts to one subtree; supplying both
   * intersects them. `dryRun: true` returns the same `MergeResult` without
   * writing.
   *
   * Source and base are read-only. Only the current destination version
   * receives `fs_entries` writes; `parent_version_id` and `version_ancestors`
   * are never modified.
   *
   * Implicit parent directories: when an applied non-null file or symlink
   * lands under a path whose ancestors are not visible in the destination,
   * those ancestors are copied from the source view (theirs preferred, then
   * ours, then base) and reported in `applied`.
   */
  async merge(
    source: string,
    opts?: {
      strategy?: MergeStrategy;
      paths?: string[];
      pathScope?: string;
      dryRun?: boolean;
    },
  ): Promise<MergeResult> {
    if (!source || source.length === 0) {
      throw new Error("merge: source must be a non-empty version label");
    }
    if (source === this.versionLabel) {
      throw new Error(
        `merge: source must differ from current version '${this.versionLabel}'`,
      );
    }
    const strategy: MergeStrategy = opts?.strategy ?? "fail";
    const dryRun = opts?.dryRun ?? false;

    const scopeUser = opts?.pathScope ? normalizePath(opts.pathScope) : "/";
    this.guardRead(scopeUser);
    const internalScope = this.toInternalPath(scopeUser);

    const pathFilters: string[] = [];
    if (opts?.paths && opts.paths.length > 0) {
      for (const p of opts.paths) {
        this.guardRead(p);
        pathFilters.push(this.toInternalPath(normalizePath(p)));
      }
    }

    return this.withWorkspace(async (tx) => {
      const ourId = await this.getCurrentVersionId(tx);
      const theirId = await this.requireVersionIdByLabel(tx, source);
      const scopeLtree = pathToLtree(internalScope, this.workspaceId);

      // LCA & ancestor fast-path. If source is itself an ancestor of current,
      // current already includes it via the live overlay, so there is nothing
      // to apply. (If current is an ancestor of source, we still want to
      // fast-forward, so we don't short-circuit on lcaId === ourId.)
      const lcaId = await this.findLCA(tx, ourId, theirId);
      if (lcaId === theirId) {
        return { applied: [], conflicts: [], skipped: [] };
      }

      const oursMap = await this.fetchVisibleEntryMap(tx, ourId, scopeLtree);
      const theirsMap = await this.fetchVisibleEntryMap(tx, theirId, scopeLtree);
      const baseMap =
        lcaId !== null
          ? await this.fetchVisibleEntryMap(tx, lcaId, scopeLtree)
          : new Map<string, InternalEntryShape>();

      // Validate scope visibility in destination — parent-dir expansion needs
      // a known-good directory at the scope boundary so it never escapes.
      // Root scope ("/") is always visible after init().
      if (internalScope !== "/") {
        const scopeOurs = oursMap.get(internalScope);
        if (!scopeOurs || scopeOurs.type !== "directory") {
          throw new FsError(
            "ENOTDIR",
            "merge: pathScope is not a visible directory in destination",
            this.toUserPath(internalScope),
          );
        }
      }

      // Candidate paths = union of all three maps, restricted by `paths`
      // filter when provided. A user-supplied filter `f` matches candidate
      // `c` iff `c === f` or `c` is a strict descendant of `f`. This treats
      // directory-shaped filters as "the directory plus its visible subtree"
      // without first deciding whether `f` is actually a directory in any
      // particular side.
      const candidatePaths = new Set<string>();
      for (const p of oursMap.keys()) candidatePaths.add(p);
      for (const p of theirsMap.keys()) candidatePaths.add(p);
      for (const p of baseMap.keys()) candidatePaths.add(p);

      let candidates: string[];
      if (pathFilters.length > 0) {
        candidates = [...candidatePaths].filter((c) =>
          pathFilters.some((f) =>
            c === f ||
            (f === "/" ? c.startsWith("/") : c.startsWith(f + "/")),
          ),
        );
      } else {
        candidates = [...candidatePaths];
      }
      candidates.sort();

      const applied: string[] = [];
      const skipped: string[] = [];
      const conflicts: ConflictEntry[] = [];
      const writes: Array<{
        internalPath: string;
        shape: InternalEntryShape | null;
      }> = [];
      const writePathSet = new Set<string>();

      for (const internalPath of candidates) {
        const ours = oursMap.get(internalPath) ?? null;
        const theirs = theirsMap.get(internalPath) ?? null;
        const base = baseMap.get(internalPath) ?? null;
        const userPath = this.toUserPath(internalPath);

        if (entryShapeEqual(ours, theirs)) {
          skipped.push(userPath);
          continue;
        }
        if (entryShapeEqual(base, ours)) {
          writes.push({ internalPath, shape: theirs });
          writePathSet.add(internalPath);
          applied.push(userPath);
          continue;
        }
        if (entryShapeEqual(base, theirs)) {
          skipped.push(userPath);
          continue;
        }

        const conflict: ConflictEntry = {
          path: userPath,
          base: toPublicEntryShape(base),
          ours: toPublicEntryShape(ours),
          theirs: toPublicEntryShape(theirs),
        };

        if (strategy === "fail") {
          conflicts.push(conflict);
        } else if (strategy === "ours") {
          conflicts.push(conflict);
          skipped.push(userPath);
        } else {
          conflicts.push(conflict);
          writes.push({ internalPath, shape: theirs });
          writePathSet.add(internalPath);
          applied.push(userPath);
        }
      }

      if (strategy === "fail" && conflicts.length > 0) {
        return { applied: [], conflicts, skipped: [] };
      }

      // Post-apply visible map (within scope) for parent expansion.
      const post = new Map(oursMap);
      for (const w of writes) {
        if (w.shape === null) post.delete(w.internalPath);
        else post.set(w.internalPath, w.shape);
      }

      // Parent-directory expansion for non-null file/symlink writes. The
      // scope check above guarantees a visible directory at `internalScope`,
      // so this walk always terminates: either we hit a visible directory in
      // post (oursMap or a write we just queued), or we reach scope itself
      // which is guaranteed visible.
      const initialWrites = writes.slice();
      for (const w of initialWrites) {
        if (w.shape === null) continue;
        if (w.shape.type !== "file" && w.shape.type !== "symlink") continue;
        let p = parentPath(w.internalPath);
        while (true) {
          const v = post.get(p);
          if (v?.type === "directory") break;
          if (v) {
            throw new FsError(
              "ENOTDIR",
              "merge: parent path is not a directory",
              this.toUserPath(p),
            );
          }
          if (p === "/") {
            // Root must always exist after init(). If we ever reach here it
            // means the workspace is corrupt.
            throw new Error(
              "merge: root directory not visible in destination",
            );
          }
          const srcDir =
            theirsMap.get(p) ?? oursMap.get(p) ?? baseMap.get(p);
          if (!srcDir || srcDir.type !== "directory") {
            throw new Error(
              `merge: cannot create implicit parent directory '${this.toUserPath(p)}': source view has no directory at this path`,
            );
          }
          if (!writePathSet.has(p)) {
            writes.push({ internalPath: p, shape: srcDir });
            writePathSet.add(p);
            applied.push(this.toUserPath(p));
          }
          post.set(p, srcDir);
          p = parentPath(p);
        }
      }

      // Batch node-count validation: query the global visible count once,
      // compute the net delta, and check `maxFiles` before any writes happen.
      // Existing single-path writes still call `validateNodeCount()` on their
      // own; merge sidesteps that loop because it knows the full apply set
      // up-front.
      if (writes.length > 0) {
        const currentCount = await this.globalVisibleCount(tx, ourId);
        let delta = 0;
        for (const w of writes) {
          const wasVisible = oursMap.has(w.internalPath);
          const willBeVisible = w.shape !== null;
          if (wasVisible && !willBeVisible) delta -= 1;
          else if (!wasVisible && willBeVisible) delta += 1;
        }
        if (currentCount + delta > this.maxFiles) {
          throw new Error(
            `Node limit reached: ${this.maxFiles} nodes per workspace`,
          );
        }
      }

      applied.sort();
      skipped.sort();

      if (dryRun || writes.length === 0) {
        return { applied, conflicts, skipped };
      }

      await this.lockVersions(tx, [ourId]);
      writes.sort((a, b) =>
        a.internalPath < b.internalPath ? -1
        : a.internalPath > b.internalPath ? 1
        : 0,
      );
      for (const w of writes) {
        await this.writeEntryShape(tx, ourId, w.internalPath, w.shape);
      }

      return { applied, conflicts, skipped };
    });
  }

  /**
   * Copy selected visible paths from `source` into the current version.
   * Source-wins, two-way: there is no LCA, no conflict reporting; for each
   * selected path either source's shape replaces destination's or — when the
   * path exists in destination but not source — a tombstone is written.
   *
   * Each entry in `paths` is a user path. A directory match (in either side)
   * pulls in the entire visible subtree. Equal paths are reported in
   * `skipped`. `conflicts` is always empty.
   *
   * Implicit parent directories: when an applied non-null file or symlink
   * lands under a path whose ancestors are not visible in the destination,
   * those ancestors are copied from the source view (theirs preferred, then
   * ours) and reported in `applied`.
   */
  async cherryPick(
    source: string,
    paths: string[],
  ): Promise<MergeResult> {
    if (!source || source.length === 0) {
      throw new Error("cherryPick: source must be a non-empty version label");
    }
    if (source === this.versionLabel) {
      throw new Error(
        `cherryPick: source must differ from current version '${this.versionLabel}'`,
      );
    }
    if (!paths || paths.length === 0) {
      throw new Error("cherryPick: paths must be a non-empty array");
    }

    const pathFilters: string[] = [];
    for (const p of paths) {
      this.guardRead(p);
      pathFilters.push(this.toInternalPath(normalizePath(p)));
    }

    return this.withWorkspace(async (tx) => {
      const ourId = await this.getCurrentVersionId(tx);
      const theirId = await this.requireVersionIdByLabel(tx, source);
      const rootLtree = pathToLtree("/", this.workspaceId);

      const oursMap = await this.fetchVisibleEntryMap(tx, ourId, rootLtree);
      const theirsMap = await this.fetchVisibleEntryMap(tx, theirId, rootLtree);

      // Candidate paths = union(ours, theirs) restricted to filter. Filter `f`
      // matches `c` iff `c === f` or `c` is a strict descendant of `f`.
      const candidatePaths = new Set<string>();
      for (const p of oursMap.keys()) candidatePaths.add(p);
      for (const p of theirsMap.keys()) candidatePaths.add(p);

      const candidates = [...candidatePaths]
        .filter((c) =>
          pathFilters.some((f) =>
            c === f ||
            (f === "/" ? c.startsWith("/") : c.startsWith(f + "/")),
          ),
        )
        .sort();

      const applied: string[] = [];
      const skipped: string[] = [];
      const writes: Array<{
        internalPath: string;
        shape: InternalEntryShape | null;
      }> = [];
      const writePathSet = new Set<string>();

      for (const internalPath of candidates) {
        const ours = oursMap.get(internalPath) ?? null;
        const theirs = theirsMap.get(internalPath) ?? null;
        const userPath = this.toUserPath(internalPath);

        if (entryShapeEqual(ours, theirs)) {
          skipped.push(userPath);
          continue;
        }
        // Source wins. `theirs === null` becomes a tombstone.
        writes.push({ internalPath, shape: theirs });
        writePathSet.add(internalPath);
        applied.push(userPath);
      }

      this.expandParentDirectories(
        writes,
        writePathSet,
        applied,
        oursMap,
        [theirsMap, oursMap],
        "cherryPick",
      );

      await this.validateBatchNodeCount(tx, ourId, writes, oursMap);

      applied.sort();
      skipped.sort();

      if (writes.length === 0) {
        return { applied, conflicts: [], skipped };
      }

      await this.lockVersions(tx, [ourId]);
      writes.sort((a, b) =>
        a.internalPath < b.internalPath ? -1
        : a.internalPath > b.internalPath ? 1
        : 0,
      );
      for (const w of writes) {
        await this.writeEntryShape(tx, ourId, w.internalPath, w.shape);
      }

      return { applied, conflicts: [], skipped };
    });
  }

  /**
   * Restore the current version's selected visible tree to match `target`.
   * For every in-scope path:
   *   - visible in target → write target's entry shape to current.
   *   - visible only in current → write a tombstone.
   * No LCA, no conflicts. Returns a `MergeResult` for observability;
   * `conflicts` is always empty.
   *
   * `paths` and `pathScope` filter the operation as in `merge()`. `pathScope`
   * does NOT need to be visible in destination — revert is the natural way to
   * bring back a deleted subtree, so the scope is treated as a fetch boundary
   * and parent expansion materializes parents from target as needed.
   */
  async revert(
    target: string,
    opts?: { paths?: string[]; pathScope?: string },
  ): Promise<MergeResult> {
    if (!target || target.length === 0) {
      throw new Error("revert: target must be a non-empty version label");
    }
    if (target === this.versionLabel) {
      throw new Error(
        `revert: target must differ from current version '${this.versionLabel}'`,
      );
    }

    const scopeUser = opts?.pathScope ? normalizePath(opts.pathScope) : "/";
    this.guardRead(scopeUser);
    const internalScope = this.toInternalPath(scopeUser);

    const pathFilters: string[] = [];
    if (opts?.paths && opts.paths.length > 0) {
      for (const p of opts.paths) {
        this.guardRead(p);
        pathFilters.push(this.toInternalPath(normalizePath(p)));
      }
    }

    return this.withWorkspace(async (tx) => {
      const ourId = await this.getCurrentVersionId(tx);
      const theirId = await this.requireVersionIdByLabel(tx, target);
      const scopeLtree = pathToLtree(internalScope, this.workspaceId);

      const oursMap = await this.fetchVisibleEntryMap(tx, ourId, scopeLtree);
      const theirsMap = await this.fetchVisibleEntryMap(tx, theirId, scopeLtree);

      const candidatePaths = new Set<string>();
      for (const p of oursMap.keys()) candidatePaths.add(p);
      for (const p of theirsMap.keys()) candidatePaths.add(p);

      let candidates: string[];
      if (pathFilters.length > 0) {
        candidates = [...candidatePaths].filter((c) =>
          pathFilters.some((f) =>
            c === f ||
            (f === "/" ? c.startsWith("/") : c.startsWith(f + "/")),
          ),
        );
      } else {
        candidates = [...candidatePaths];
      }
      candidates.sort();

      const applied: string[] = [];
      const skipped: string[] = [];
      const writes: Array<{
        internalPath: string;
        shape: InternalEntryShape | null;
      }> = [];
      const writePathSet = new Set<string>();

      for (const internalPath of candidates) {
        const ours = oursMap.get(internalPath) ?? null;
        const theirs = theirsMap.get(internalPath) ?? null;
        const userPath = this.toUserPath(internalPath);

        if (entryShapeEqual(ours, theirs)) {
          skipped.push(userPath);
          continue;
        }
        writes.push({ internalPath, shape: theirs });
        writePathSet.add(internalPath);
        applied.push(userPath);
      }

      this.expandParentDirectories(
        writes,
        writePathSet,
        applied,
        oursMap,
        [theirsMap, oursMap],
        "revert",
      );

      await this.validateBatchNodeCount(tx, ourId, writes, oursMap);

      applied.sort();
      skipped.sort();

      if (writes.length === 0) {
        return { applied, conflicts: [], skipped };
      }

      await this.lockVersions(tx, [ourId]);
      writes.sort((a, b) =>
        a.internalPath < b.internalPath ? -1
        : a.internalPath > b.internalPath ? 1
        : 0,
      );
      for (const w of writes) {
        await this.writeEntryShape(tx, ourId, w.internalPath, w.shape);
      }

      return { applied, conflicts: [], skipped };
    });
  }

  /**
   * Walk parent paths up from each non-null file/symlink write. If a parent
   * is missing in the post-apply view, copy it from the first source map that
   * has a directory at that path (`sources` checked in order). Mutates
   * `writes`, `writePathSet`, and `applied` in place. Used by `cherryPick()`
   * and `revert()`; `merge()` inlines the same logic with a base map.
   */
  private expandParentDirectories(
    writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
    writePathSet: Set<string>,
    applied: string[],
    oursMap: Map<string, InternalEntryShape>,
    sources: Array<Map<string, InternalEntryShape>>,
    op: string,
  ): void {
    const post = new Map(oursMap);
    for (const w of writes) {
      if (w.shape === null) post.delete(w.internalPath);
      else post.set(w.internalPath, w.shape);
    }
    const initialWrites = writes.slice();
    for (const w of initialWrites) {
      if (w.shape === null) continue;
      if (w.shape.type !== "file" && w.shape.type !== "symlink") continue;
      let p = parentPath(w.internalPath);
      while (true) {
        const v = post.get(p);
        if (v?.type === "directory") break;
        if (v) {
          throw new FsError(
            "ENOTDIR",
            `${op}: parent path is not a directory`,
            this.toUserPath(p),
          );
        }
        if (p === "/") {
          throw new Error(
            `${op}: root directory not visible in destination`,
          );
        }
        let srcDir: InternalEntryShape | undefined;
        for (const m of sources) {
          const v2 = m.get(p);
          if (v2 && v2.type === "directory") {
            srcDir = v2;
            break;
          }
        }
        if (!srcDir) {
          throw new Error(
            `${op}: cannot create implicit parent directory '${this.toUserPath(p)}': source view has no directory at this path`,
          );
        }
        if (!writePathSet.has(p)) {
          writes.push({ internalPath: p, shape: srcDir });
          writePathSet.add(p);
          applied.push(this.toUserPath(p));
        }
        post.set(p, srcDir);
        p = parentPath(p);
      }
    }
  }

  /**
   * Batch node-count check for `cherryPick()` / `revert()`: queries the
   * workspace's visible count once and compares it against `maxFiles` after
   * applying the planned write delta. Throws before any write happens.
   */
  private async validateBatchNodeCount(
    tx: SqlClient,
    versionId: number,
    writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
    oursMap: Map<string, InternalEntryShape>,
  ): Promise<void> {
    if (writes.length === 0) return;
    const currentCount = await this.globalVisibleCount(tx, versionId);
    let delta = 0;
    for (const w of writes) {
      const wasVisible = oursMap.has(w.internalPath);
      const willBeVisible = w.shape !== null;
      if (wasVisible && !willBeVisible) delta -= 1;
      else if (!wasVisible && willBeVisible) delta += 1;
    }
    if (currentCount + delta > this.maxFiles) {
      throw new Error(
        `Node limit reached: ${this.maxFiles} nodes per workspace`,
      );
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
 * Build the displaced-label format used by `renameVersion({ swap: true })`:
 * `<newLabel>-prev-YYYYMMDDHHMMSS-<displacedId>`. The trailing version ID
 * makes the label unique within a workspace even if two swaps land in the
 * same UTC second.
 */
function generatePrevLabel(newLabel: string, displacedId: number): string {
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
 * Map a PostgreSQL unique-violation (`23505`) on `unique_workspace_version_label`
 * to a clear public error. Other errors pass through unchanged.
 */
function mapVersionLabelUniqueViolation(e: unknown, label: string): unknown {
  if (
    e instanceof SqlError &&
    e.code === "23505" &&
    (e.constraint === "unique_workspace_version_label" ||
      (e.detail ?? "").includes("workspace_id") ||
      e.message.includes("unique_workspace_version_label"))
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

/**
 * Convert an `InternalEntryShape` (with raw `Uint8Array` blob hash) into the
 * public `EntryShape` (with hex-encoded blob hash). Used for `merge()` /
 * `cherryPick()` / `revert()` conflict reports.
 */
function toPublicEntryShape(
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

function mapDiffSide(
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

function classifyDiffChange(
  before: EntryShape | null,
  after: EntryShape | null,
): "added" | "removed" | "modified" | "type-changed" {
  if (before === null) return "added";
  if (after === null) return "removed";
  if (before.type !== after.type) return "type-changed";
  return "modified";
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
