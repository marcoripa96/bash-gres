import { randomUUID } from "crypto";
import type {
  SqlClient,
  SqlParam,
  PgFileSystemOptions,
  FsStat,
  DirentEntry,
  DirentStatEntry,
  WalkEntry,
  MkdirOptions,
  CpOptions,
  NodeType,
} from "../types.js";
import { FsError, FsQuotaError, SqlError } from "../types.js";
import { readonlySqlClient } from "../readonly.js";
import {
  pathToLtree,
  ltreeToPath,
  ltreeFileName,
  normalizePath,
  parentPath,
  fileName,
} from "../path-encoding.js";
import { validateEmbedding } from "../search.js";
import {
  compileExcludes,
  excludeWhereSql,
  isExcluded,
  type CompiledExcludes,
} from "../exclude.js";
import {
  DEFAULT_MAX_CP_NODES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_SYMLINK_DEPTH,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_VERSION,
  TOMBSTONE,
} from "./internals/constants.js";
import type { InternalEntryShape } from "./internals/entry-shapes.js";
import { sha256 } from "./internals/hashes.js";
import type {
  BlobRow,
  DirChildRow,
  EntryRow,
  SubtreeRow,
  VersionRootRow,
} from "./internals/rows.js";

export class FsBase {
  protected client: SqlClient;
  protected rawDb: SqlClient;
  readonly workspaceId: string;
  /**
   * Mutable backing for the public `version` getter. Internal code that needs
   * to change the instance's label after a successful commit (e.g. `renameVersion()`)
   * writes here.
   */
  protected versionLabel: string;
  readonly permissions: { read: boolean; write: boolean };
  protected maxFileSize: number;
  protected maxReadSize: number | undefined;
  protected maxFiles: number;
  protected maxWorkspaceBytes: number | undefined;
  protected maxDepth: number;
  protected maxSymlinkDepth: number;
  protected maxCpNodes: number;
  protected statementTimeoutMs: number;
  protected embed?: (text: string) => Promise<number[]>;
  protected embeddingDimensions?: number;
  protected rootDir: string;
  protected versionRootPath: string;
  protected excludes: CompiledExcludes;
  protected readonly baseOptions: PgFileSystemOptions;
  protected cachedVersionId: number | null = null;
  protected cachedVersionRootId: number | null = null;
  protected blobsHasEmbeddingCache: boolean | null = null;
  /**
   * Optimistic visible-node count for `validateNodeCount`. Avoids running a
   * `COUNT(*)` over the COW-resolved view of the whole workspace on every
   * write while there's still comfortable headroom under `maxFiles`. May
   * drift upward when entries are removed (we never decrement); the drift
   * is self-correcting because as the cache approaches `maxFiles` we fall
   * back to the real `COUNT` and reset.
   */
  protected cachedNodeCount: number | null = null;
  /**
   * When non-null, this instance is a transaction-bound facade. All `withWorkspace()`
   * calls on the facade run `fn(txClient)` directly instead of opening a new
   * transaction. The outer `transaction()` call has already wired up RLS
   * (`app.workspace_id`) and `statement_timeout` on this client.
   */
  protected txClient: SqlClient | null = null;
  /**
   * Hooks queued by tx-bound facade methods (e.g. `renameVersion()`) to apply
   * instance-state mutations on the originating instance only after the outer
   * transaction commits. Set on the facade by `transaction()`; never mutated on
   * a top-level instance.
   */
  protected postCommitHooks: Array<() => void> | null = null;
  /**
   * The instance that produced this facade via `createTxFacade()`. Used so that
   * post-commit hooks (such as label updates) can target the surviving outer
   * instance rather than the transient facade.
   */
  protected originInstance: this | null = null;
  /**
   * Lazily-built `SqlClient` that auto-injects `set_config('app.workspace_id',...)`
   * and `set_config('statement_timeout',...)` as a CTE on every read query.
   * Lets single-statement reads bypass the BEGIN/SET/COMMIT triplet — the
   * `set_config(local=true)` calls take effect inside the implicit per-statement
   * transaction so RLS and the timeout are still honored.
   */
  private cachedReadOnlyClient: SqlClient | null = null;

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
    this.versionRootPath = normalizePath(options.versionRoot ?? "/");
    this.excludes = compileExcludes(
      options.exclude,
      this.rootDir,
      this.workspaceId,
    );
    this.baseOptions = {
      ...options,
      workspaceId: this.workspaceId,
      versionRoot: this.versionRootPath,
    };
  }

  /**
   * The version label this instance is bound to. Backed by a mutable private field
   * so that operations like `renameVersion()` can update the label after commit.
   */
  get version(): string {
    return this.versionLabel;
  }

  /** Absolute workspace path that owns this instance's version graph. */
  get versionRoot(): string {
    return this.versionRootPath;
  }

  // -- Transaction wrapper (sets RLS context + timeout) -----------------------

  /**
   * Open a transaction on `client`, install the per-tx workspace + timeout
   * settings, and run `fn`. Used by both `withWorkspace()` and `transaction()`.
   */
  protected runInWorkspace<T>(
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
  protected async withWorkspace<T>(
    fn: (tx: SqlClient) => Promise<T>,
  ): Promise<T> {
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

  /**
   * Read-only variant of `withWorkspace`. When not inside an outer transaction,
   * runs `fn` against a wrapper client that injects `set_config` for RLS and
   * statement timeout as a CTE on every query — saving the BEGIN/SET/COMMIT
   * round-trips that a normal `withWorkspace` would incur. Each query inside
   * `fn` runs in its own implicit transaction; callers must not depend on
   * cross-query snapshot atomicity (real filesystem reads aren't atomic across
   * calls either).
   */
  protected async withReadOnlyWorkspace<T>(
    fn: (tx: SqlClient) => Promise<T>,
  ): Promise<T> {
    try {
      if (this.txClient) {
        return await fn(this.txClient);
      }
      return await fn(this.getReadOnlyClient());
    } catch (e) {
      if (e instanceof SqlError && e.code === "25006") {
        throw new FsError("EPERM", "read-only file system", "/");
      }
      throw e;
    }
  }

  private getReadOnlyClient(): SqlClient {
    if (this.cachedReadOnlyClient) return this.cachedReadOnlyClient;
    const inner = this.client;
    const workspaceId = this.workspaceId;
    const timeoutStr = String(this.statementTimeoutMs);
    const wrap = (text: string, params: SqlParam[]): { sql: string; params: SqlParam[] } => {
      const wsIdx = params.length + 1;
      const toIdx = params.length + 2;
      const setupCte = `_ws AS MATERIALIZED (SELECT set_config('app.workspace_id', $${wsIdx}, true) AS ws, set_config('statement_timeout', $${toIdx}, true) AS st)`;
      const stripped = text.replace(/^[\s;]+/, "");
      const withMatch = /^WITH(\s+RECURSIVE)?(\s+)/i.exec(stripped);
      const wrappedText = withMatch
        ? `WITH${withMatch[1] ?? ""}${withMatch[2]}${setupCte}, ${stripped.slice(withMatch[0].length)}`
        : `WITH ${setupCte} ${stripped}`;
      return { sql: wrappedText, params: [...params, workspaceId, timeoutStr] };
    };
    this.cachedReadOnlyClient = {
      query: async (text, params = []) => {
        const w = wrap(text, params);
        return inner.query(w.sql, w.params);
      },
      transaction: inner.transaction.bind(inner),
    };
    return this.cachedReadOnlyClient;
  }

  /**
   * Run `fn` inside a single database transaction. `fn` receives a
   * transaction-bound facade for the same workspace, version, permissions,
   * limits, and rootDir. Multiple operations on the facade share the same
   * transaction: if `fn` throws or rejects, every write rolls back; if `fn`
   * returns, the transaction commits and the return value is the
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
  async transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    if (this.txClient) {
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
   * Build a transaction-bound facade that shares this instance's configuration
   * and runs every operation against the supplied SQL transaction client.
   */
  protected createTxFacade(
    sqlTx: SqlClient,
    postCommitHooks: Array<() => void>,
  ): this {
    const Ctor = this.constructor as new (opts: PgFileSystemOptions) => this;
    const facade = new Ctor({
      ...this.baseOptions,
      db: this.rawDb,
      // Use the live label, not the construction-time one, so a facade created
      // after a successful renameVersion() still points at the right version.
      version: this.versionLabel,
    });
    facade.txClient = sqlTx;
    facade.cachedVersionId = this.cachedVersionId;
    facade.cachedVersionRootId = this.cachedVersionRootId;
    facade.postCommitHooks = postCommitHooks;
    facade.originInstance = this;
    return facade;
  }

  // -- Version root resolution ------------------------------------------------

  protected async getVersionRootId(tx: SqlClient): Promise<number> {
    if (this.cachedVersionRootId !== null) return this.cachedVersionRootId;
    const rootLtree = pathToLtree(this.versionRootPath, this.workspaceId);
    const r = await tx.query<{ id: number }>(
      `SELECT id FROM fs_version_roots
       WHERE workspace_id = $1 AND path = $2::ltree
       LIMIT 1`,
      [this.workspaceId, rootLtree],
    );
    if (r.rows.length > 0) {
      this.cachedVersionRootId = Number(r.rows[0]!.id);
      return this.cachedVersionRootId;
    }

    if (this.versionRootPath !== "/") {
      throw new FsError(
        "ENOTVERSIONED",
        "not a versioned directory",
        this.toUserPath(this.versionRootPath),
      );
    }

    this.cachedVersionRootId = await this.createVersionRootRecord(tx, "/");
    return this.cachedVersionRootId;
  }

  protected async createVersionRootRecord(
    tx: SqlClient,
    internalPath: string,
  ): Promise<number> {
    const rootLtree = pathToLtree(internalPath, this.workspaceId);
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM fs_version_roots
       WHERE workspace_id = $1 AND path = $2::ltree
       LIMIT 1`,
      [this.workspaceId, rootLtree],
    );
    if (existing.rows.length > 0) return Number(existing.rows[0]!.id);

    const created = await tx.query<{ id: number }>(
      `INSERT INTO fs_version_roots (workspace_id, path)
       VALUES ($1, $2::ltree)
       ON CONFLICT (workspace_id, path) DO UPDATE SET path = EXCLUDED.path
       RETURNING id`,
      [this.workspaceId, rootLtree],
    );
    return Number(created.rows[0]!.id);
  }

  protected async assertCanCreateVersionRoot(
    tx: SqlClient,
    internalPath: string,
  ): Promise<void> {
    if (internalPath === "/") return;
    const rootLtree = pathToLtree("/", this.workspaceId);
    const targetLtree = pathToLtree(internalPath, this.workspaceId);
    const r = await tx.query<VersionRootRow>(
      `SELECT id, path::text AS path
       FROM fs_version_roots
       WHERE workspace_id = $1
         AND path != $2::ltree
         AND path != $3::ltree
         AND (path @> $3::ltree OR path <@ $3::ltree)
       LIMIT 1`,
      [this.workspaceId, rootLtree, targetLtree],
    );
    if (r.rows.length > 0) {
      throw new FsError(
        "EINVAL",
        "nested versioned directories are not supported",
        this.toUserPath(internalPath),
      );
    }
  }

  protected async ensureVersionRootInitialized(
    tx: SqlClient,
    internalPath: string,
  ): Promise<void> {
    await this.assertCanCreateVersionRoot(tx, internalPath);
    const versionRootId = await this.createVersionRootRecord(tx, internalPath);

    const existingVersion = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
       LIMIT 1`,
      [this.workspaceId, versionRootId, DEFAULT_VERSION],
    );
    if (existingVersion.rows.length > 0) return;

    const created = await tx.query<{ id: number }>(
      `INSERT INTO fs_versions (workspace_id, version_root_id, label, parent_version_id)
       VALUES ($1, $2, $3, NULL)
       RETURNING id`,
      [this.workspaceId, versionRootId, DEFAULT_VERSION],
    );
    const versionId = Number(created.rows[0]!.id);
    await tx.query(
      `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
       VALUES ($1, $2, $2, 0)`,
      [this.workspaceId, versionId],
    );

    const sourceVersionId = await this.getCurrentVersionId(tx);
    const mountLtree = pathToLtree(internalPath, this.workspaceId);
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
                e.mode, e.size_bytes, e.mtime
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $3
           AND e.path <@ $4::ltree
         ORDER BY e.path, a.depth ASC
       ) src
       WHERE src.node_type <> 'tombstone'
       ON CONFLICT (workspace_id, version_id, path) DO NOTHING`,
      [this.workspaceId, versionId, sourceVersionId, mountLtree],
    );
  }

  // -- Version resolution -----------------------------------------------------

  protected async getCurrentVersionId(tx: SqlClient): Promise<number> {
    if (this.cachedVersionId !== null) return this.cachedVersionId;
    const versionRootId = await this.getVersionRootId(tx);
    const r = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
       LIMIT 1`,
      [this.workspaceId, versionRootId, this.versionLabel],
    );
    if (r.rows.length === 0) {
      throw new Error(
        `Version '${this.versionLabel}' does not exist in workspace '${this.workspaceId}'. Call init() or fork() first.`,
      );
    }
    this.cachedVersionId = Number(r.rows[0].id);
    return this.cachedVersionId;
  }

  protected async ensureVersion(tx: SqlClient): Promise<number> {
    if (this.cachedVersionId !== null) return this.cachedVersionId;
    const versionRootId = await this.getVersionRootId(tx);
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
       LIMIT 1`,
      [this.workspaceId, versionRootId, this.versionLabel],
    );
    if (existing.rows.length > 0) {
      this.cachedVersionId = Number(existing.rows[0].id);
      return this.cachedVersionId;
    }
    const created = await tx.query<{ id: number }>(
      `INSERT INTO fs_versions (workspace_id, version_root_id, label, parent_version_id)
       VALUES ($1, $2, $3, NULL)
       RETURNING id`,
      [this.workspaceId, versionRootId, this.versionLabel],
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
  protected async getVersionIdByLabel(
    tx: SqlClient,
    label: string,
  ): Promise<number | null> {
    const versionRootId = await this.getVersionRootId(tx);
    const r = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
       LIMIT 1`,
      [this.workspaceId, versionRootId, label],
    );
    return r.rows.length > 0 ? Number(r.rows[0]!.id) : null;
  }

  protected async requireVersionIdByLabel(
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
  protected async lockVersions(
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
  protected async findLCA(
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
  protected async globalVisibleCount(
    tx: SqlClient,
    versionId: number,
  ): Promise<number> {
    const baseParams: SqlParam[] = [this.workspaceId, versionId, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const r = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT DISTINCT ON (e.path) e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1 AND a.descendant_id = $2
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       ) v WHERE node_type != $3`,
      [...baseParams, ...exc.params],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  // -- Visibility resolution --------------------------------------------------

  /**
   * Find the visible entry at `posixPath` for the current version, walking the
   * version-ancestors closure to the closest ancestor that has a row at this path.
   * Returns null if not visible (no ancestor has a row, or the closest hit is a tombstone).
   */
  protected async resolveEntry(
    tx: SqlClient,
    posixPath: string,
  ): Promise<EntryRow | null> {
    if (!this.excludes.empty && isExcluded(this.excludes, posixPath)) {
      return null;
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(posixPath, this.workspaceId);
    // Flip: select entries at this exact path first (typically 1 row), then
    // join to the descendant's ancestor closure to pick the nearest ancestor
    // that owns it. The lateral form probes once per ancestor (O(chain_depth)
    // GiST lookups); this form does a single path lookup plus an ordered
    // closure scan with a cheap join filter, regardless of chain depth.
    //
    // The CTE is `MATERIALIZED` deliberately: under prepared-statement plan
    // caching, postgres switches to a generic plan after ~5 executions, and
    // its generic costing for the un-fenced shape inverts the join order
    // (drives from ancestors, probes the path GiST 51× per read at depth 50).
    // Materializing the path lookup keeps it as the build side of the join.
    const r = await tx.query<EntryRow>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, mode, size_bytes, mtime, created_at
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       )
       SELECT e.workspace_id, e.version_id, e.path::text AS path, e.blob_hash,
              e.node_type, e.symlink_target, e.mode, e.size_bytes, e.mtime, e.created_at
       FROM e
       JOIN version_ancestors a
         ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
       WHERE a.descendant_id = $3
       ORDER BY a.depth ASC
       LIMIT 1`,
      [this.workspaceId, lt, versionId],
    );
    const row = r.rows[0];
    if (!row || row.node_type === TOMBSTONE) return null;
    return row;
  }

  /**
   * Visibility lookup for many paths in a single round-trip. Mirrors
   * `resolveEntry` but unrolls over an array of requested paths, evaluates
   * each one's nearest-ancestor row independently, and returns a Map keyed
   * by the original input path. Lets hot write paths fold parent-existence
   * + existing-entry checks into one query.
   *
   * Single-path callers should keep using `resolveEntry`: the planner
   * picks a tighter plan for a literal `path = $n::ltree` predicate than
   * for `path = req.p` over `unnest`, and we don't want to regress reads
   * for the savings on writes.
   */
  protected async resolveEntries(
    tx: SqlClient,
    posixPaths: string[],
  ): Promise<Map<string, EntryRow | null>> {
    const out = new Map<string, EntryRow | null>();
    const lookups: { posix: string; lt: string }[] = [];
    for (const posix of posixPaths) {
      if (out.has(posix)) continue;
      if (!this.excludes.empty && isExcluded(this.excludes, posix)) {
        out.set(posix, null);
        continue;
      }
      lookups.push({ posix, lt: pathToLtree(posix, this.workspaceId) });
      out.set(posix, null);
    }
    if (lookups.length === 0) return out;
    if (lookups.length === 1) {
      // Single path: defer to the indexed direct-equality plan.
      const only = lookups[0]!;
      const row = await this.resolveEntry(tx, only.posix);
      if (row) out.set(only.posix, row);
      return out;
    }

    const versionId = await this.getCurrentVersionId(tx);
    const ltArray = lookups.map((l) => l.lt);
    // DISTINCT ON (path) over an ordered scan picks the nearest-ancestor row
    // per requested path. Same flip and same MATERIALIZED fence as
    // resolveEntry — keep the path lookup as the build side of the join even
    // under generic plan caching.
    const r = await tx.query<EntryRow>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, mode, size_bytes, mtime, created_at
         FROM fs_entries
         WHERE workspace_id = $1 AND path = ANY($2::ltree[])
       )
       SELECT DISTINCT ON (e.path)
              e.workspace_id, e.version_id, e.path::text AS path, e.blob_hash,
              e.node_type, e.symlink_target, e.mode, e.size_bytes, e.mtime, e.created_at
       FROM e
       JOIN version_ancestors a
         ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
       WHERE a.descendant_id = $3
       ORDER BY e.path, a.depth ASC`,
      [this.workspaceId, ltArray, versionId],
    );
    const ltToPosix = new Map<string, string>();
    for (const l of lookups) ltToPosix.set(l.lt, l.posix);
    for (const row of r.rows) {
      if (row.node_type === TOMBSTONE) continue;
      const posix = ltToPosix.get(row.path);
      if (posix !== undefined) out.set(posix, row);
    }
    return out;
  }

  protected async resolveEntryFollowSymlink(
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

  protected async getBlob(
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

  protected async listVisibleChildren(
    tx: SqlClient,
    parentPosix: string,
  ): Promise<DirChildRow[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(parentPosix, this.workspaceId);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
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
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT * FROM visible WHERE node_type != $4 ORDER BY path`,
      [...baseParams, ...exc.params],
    );
    return r.rows;
  }

  protected async listVisibleChildNames(
    tx: SqlClient,
    parentPosix: string,
  ): Promise<string[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(parentPosix, this.workspaceId);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const r = await tx.query<{ path: string; node_type: string }>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND e.path != $3::ltree
           AND nlevel(e.path) = nlevel($3::ltree) + 1
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT path, node_type FROM visible WHERE node_type != $4 ORDER BY path`,
      [...baseParams, ...exc.params],
    );
    return r.rows.map((row) => ltreeFileName(row.path));
  }

  /**
   * Fetch every visible (non-tombstone) entry under `scopeLtree` for
   * `versionId`, keyed by internal POSIX path. Used by batch primitives
   * (merge/cherryPick/revert) to do classification entirely in TypeScript
   * once each side's tree is in memory.
   */
  protected async fetchVisibleEntryMap(
    tx: SqlClient,
    versionId: number,
    scopeLtree: string,
  ): Promise<Map<string, InternalEntryShape>> {
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      scopeLtree,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
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
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT path, node_type, blob_hash, symlink_target, mode, size_bytes, mtime
       FROM visible WHERE node_type != $4`,
      [...baseParams, ...exc.params],
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

  protected async listVisibleSubtree(
    tx: SqlClient,
    rootPosix: string,
    includeRoot = false,
  ): Promise<SubtreeRow[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const filter = includeRoot ? "" : "AND e.path != $3::ltree";
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
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
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT * FROM visible WHERE node_type != $4 ORDER BY path`,
      [...baseParams, ...exc.params],
    );
    return r.rows;
  }

  // -- Symlink target resolution ---------------------------------------------

  protected resolveLinkTargetPath(linkPath: string, target: string): string {
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

  protected validateFileSize(content: string | Uint8Array): void {
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

  protected async validateNodeCount(tx: SqlClient): Promise<void> {
    // Headroom: as long as the cached count plus this margin is still under
    // `maxFiles`, skip the COUNT(*) and bump the cache optimistically. Once
    // we're inside the margin we re-query on every call so the limit stays
    // strictly enforced near the boundary.
    const HEADROOM = 16;
    if (
      this.cachedNodeCount !== null &&
      this.cachedNodeCount + HEADROOM < this.maxFiles
    ) {
      this.cachedNodeCount++;
      return;
    }

    const versionId = await this.getCurrentVersionId(tx);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const r = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT DISTINCT ON (e.path) e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1 AND a.descendant_id = $2
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       ) v WHERE node_type != $3`,
      [...baseParams, ...exc.params],
    );
    const actual = Number(r.rows[0]?.count ?? 0);
    this.cachedNodeCount = actual + 1;
    if (r.rows[0] && r.rows[0].count >= this.maxFiles) {
      throw new Error(
        `Node limit reached: ${this.maxFiles} nodes per workspace`,
      );
    }
  }

  protected validatePathDepth(path: string): void {
    const depth = path.split("/").filter(Boolean).length;
    if (depth > this.maxDepth) {
      throw new Error(
        `Path too deep: ${depth} levels exceeds maximum of ${this.maxDepth}`,
      );
    }
  }

  // -- Path translation & access guards ---------------------------------------

  protected toInternalPath(userPath: string): string {
    const p = normalizePath(userPath);
    if (this.rootDir === "/") return p;
    return p === "/" ? this.rootDir : normalizePath(this.rootDir + p);
  }

  protected toUserPath(internalPath: string): string {
    if (this.rootDir === "/") return internalPath;
    if (internalPath === this.rootDir) return "/";
    return internalPath.slice(this.rootDir.length);
  }

  protected guardRead(userPath: string): string {
    return this.toInternalPath(normalizePath(userPath));
  }

  protected guardWrite(userPath: string): string {
    return this.toInternalPath(normalizePath(userPath));
  }

  /**
   * Build the SQL fragment that filters out excluded paths from a result set.
   * Returns `{ sql: "TRUE", params: [] }` when no patterns are configured.
   *
   * `pathExpr` names the ltree path column in the surrounding query
   * (e.g. `e.path`, `path`, `src.path`). `nextParamIdx` is the next free `$N`.
   */
  protected buildExcludeClause(
    pathExpr: string,
    nextParamIdx: number,
  ): { sql: string; params: SqlParam[] } {
    return excludeWhereSql(this.excludes, pathExpr, nextParamIdx);
  }

  /**
   * Throw `ENOENT` if `internalPath` matches an exclude pattern. Used by every
   * public write method so that excluded paths are invisible to writers, not
   * merely shadowed at read time.
   */
  protected guardExcludedWrite(
    internalPath: string,
    op: string,
    userPath: string,
  ): void {
    if (this.excludes.empty) return;
    if (isExcluded(this.excludes, internalPath)) {
      throw new FsError("ENOENT", `no such file or directory, ${op}`, userPath);
    }
  }

  protected guardRootBoundary(internalPath: string): void {
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

  protected mapDirChildToDirent(row: DirChildRow): DirentEntry {
    return {
      name: ltreeFileName(row.path),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
    };
  }

  protected mapDirChildToStatEntry(row: DirChildRow): DirentStatEntry {
    return {
      name: ltreeFileName(row.path),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
      symlinkTarget: row.symlink_target,
    };
  }

  protected mapSubtreeToWalk(row: SubtreeRow): WalkEntry {
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

  protected statFromEntry(row: EntryRow): FsStat {
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

  protected async upsertBlob(
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

  protected async validateWorkspaceBytes(
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

  /**
   * Fused blob+entry upsert for the file write hot path. Runs both INSERTs
   * in a single CTE so the round-trip count drops from 2 → 1; data-modifying
   * statements in `WITH` clauses are always evaluated by Postgres regardless
   * of whether the outer query references them. Used only for `node_type =
   * 'file'` writes; symlinks, directories, and bulk copy paths still go
   * through `upsertBlob` / `upsertEntry` separately because they have
   * different shapes (no blob, embedding-only refresh, etc.).
   */
  protected async upsertFileBlobAndEntry(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    hash: Uint8Array,
    content: string | Uint8Array,
    sizeBytes: number,
    embedding: number[] | null,
    mode: number,
  ): Promise<void> {
    await this.validateWorkspaceBytes(tx, hash, sizeBytes, posixPath);

    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const lt = pathToLtree(posixPath, this.workspaceId);

    if (embedding !== null) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await tx.query(
        `WITH b AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)
           ON CONFLICT (workspace_id, hash) DO UPDATE SET
             embedding = COALESCE(fs_blobs.embedding, EXCLUDED.embedding)
           RETURNING 1
         )
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         VALUES ($1, $7, $8::ltree, $2, 'file', NULL, $9, $5, now())
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          embeddingStr,
          versionId,
          lt,
          mode,
        ],
      );
    } else {
      await tx.query(
        `WITH b AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, hash) DO NOTHING
           RETURNING 1
         )
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         VALUES ($1, $6, $7::ltree, $2, 'file', NULL, $8, $5, now())
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          versionId,
          lt,
          mode,
        ],
      );
    }
  }

  protected async upsertEntry(
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

  protected async writeTombstone(
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

  protected async writeTombstonesForVisibleSubtree(
    tx: SqlClient,
    versionId: number,
    rootPosix: string,
    includeRoot: boolean,
  ): Promise<void> {
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const filter = includeRoot ? "" : "AND e.path != $3::ltree";
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      lt,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    await tx.query(
      `INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type, mode, size_bytes, mtime)
       SELECT $1, $2, visible.path, NULL, $4, 0, 0, now()
       FROM (
         SELECT DISTINCT ON (e.path)
           e.path,
           e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           ${filter}
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       ) visible
       WHERE visible.node_type != $4
       ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
         blob_hash = NULL,
         node_type = $4,
         symlink_target = NULL,
         mode = 0,
         size_bytes = 0,
         mtime = now()`,
      [...baseParams, ...exc.params],
    );
  }

  protected async copyVisibleSubtreeEntries(
    tx: SqlClient,
    versionId: number,
    srcPosix: string,
    destPosix: string,
    includeRoot: boolean,
  ): Promise<void> {
    const srcLt = pathToLtree(srcPosix, this.workspaceId);
    const destLt = pathToLtree(destPosix, this.workspaceId);
    const rootFilter = includeRoot ? "" : "AND visible.path != $3::ltree";
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      srcLt,
      destLt,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    await tx.query(
      `INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type,
          symlink_target, mode, size_bytes, mtime)
       SELECT
         $1,
         $2,
         CASE
           WHEN visible.path = $3::ltree THEN $4::ltree
           ELSE $4::ltree || subpath(visible.path, nlevel($3::ltree))
         END,
         visible.blob_hash,
         visible.node_type,
         visible.symlink_target,
         visible.mode,
         visible.size_bytes,
         now()
       FROM (
         SELECT DISTINCT ON (e.path)
           e.path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND ${exc.sql}
          ORDER BY e.path, a.depth ASC
        ) visible
        WHERE visible.node_type != $5
          ${rootFilter}
        ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
          blob_hash = EXCLUDED.blob_hash,
          node_type = EXCLUDED.node_type,
         symlink_target = EXCLUDED.symlink_target,
         mode = EXCLUDED.mode,
         size_bytes = EXCLUDED.size_bytes,
         mtime = now()`,
      [...baseParams, ...exc.params],
    );
  }

  protected async countVisibleSubtreeNodes(
    tx: SqlClient,
    versionId: number,
    rootPosix: string,
  ): Promise<{ total: number; files: number }> {
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      lt,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const r = await tx.query<{ total: number; files: number }>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path,
           e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND ${exc.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE node_type = 'file')::int AS files
       FROM visible
       WHERE node_type != $4`,
      [...baseParams, ...exc.params],
    );
    return {
      total: Number(r.rows[0]?.total ?? 0),
      files: Number(r.rows[0]?.files ?? 0),
    };
  }

  /**
   * Apply a pre-fetched entry shape to the destination version's `fs_entries`.
   * Used by batch operations (merge, cherry-pick, revert, detach) to copy
   * within the same workspace without rehashing content. A `null` shape writes
   * a tombstone.
   */
  protected async writeEntryShape(
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

  protected async writeEntryShapes(
    tx: SqlClient,
    versionId: number,
    writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
  ): Promise<void> {
    if (writes.length === 0) return;

    const CHUNK_SIZE = 4000;
    for (let start = 0; start < writes.length; start += CHUNK_SIZE) {
      const chunk = writes.slice(start, start + CHUNK_SIZE);
      const params: SqlParam[] = [this.workspaceId, versionId];
      const values: string[] = [];
      for (const w of chunk) {
        const shape = w.shape;
        const idx = params.length + 1;
        values.push(
          `($${idx}::ltree, $${idx + 1}::bytea, $${idx + 2}::text, $${idx + 3}::text, $${idx + 4}::int, $${idx + 5}::bigint)`,
        );
        params.push(
          pathToLtree(w.internalPath, this.workspaceId),
          shape?.blobHash ?? null,
          shape?.type ?? TOMBSTONE,
          shape?.symlinkTarget ?? null,
          shape?.mode ?? 0,
          shape?.sizeBytes ?? 0,
        );
      }

      await tx.query(
        `WITH input(path, blob_hash, node_type, symlink_target, mode, size_bytes) AS (
           VALUES ${values.join(", ")}
         )
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         SELECT $1, $2, path, blob_hash, node_type, symlink_target, mode, size_bytes, now()
         FROM input
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        params,
      );
    }
  }

  protected async internalWriteFile(
    tx: SqlClient,
    versionId: number,
    path: string,
    content: string | Uint8Array,
    precomputedEmbedding?: number[] | null,
  ): Promise<void> {
    this.validateFileSize(content);
    this.validatePathDepth(path);

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

    // Embedding writes still take the older two-step path because the blob
    // INSERT shape differs (extra column, different ON CONFLICT projection)
    // and re-using the fused statement would force everything through a
    // CASE-laden query.
    if (embedding !== null) {
      const parentPosix = parentPath(path);
      const resolved = await this.resolveEntries(tx, [parentPosix, path]);
      const parent = resolved.get(parentPosix) ?? null;
      if (!parent)
        throw new FsError("ENOENT", "no such file or directory, open", path);
      if (parent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, open", path);
      const existing = resolved.get(path) ?? null;
      if (existing?.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, open",
          path,
        );
      if (!existing) {
        await this.validateNodeCount(tx);
      }
      await this.upsertFileBlobAndEntry(
        tx,
        versionId,
        path,
        hash,
        content,
        sizeBytes,
        embedding,
        0o644,
      );
      return;
    }

    // Workspace-byte quota check (no-op when maxWorkspaceBytes is unset).
    // Runs before the fused query so a quota refusal never persists either
    // the blob row or the entry row.
    await this.validateWorkspaceBytes(tx, hash, sizeBytes, path);

    // Optimistic node-count check: assume we'll insert. If the upsert turns
    // out to be an overwrite (xmax != 0 in the entry RETURNING), undo the
    // increment below. validateNodeCount() throws at the boundary; if it
    // throws we never run the fused query.
    await this.validateNodeCount(tx);

    const parentPosix = parentPath(path);
    const parentLt = pathToLtree(parentPosix, this.workspaceId);
    const targetLt = pathToLtree(path, this.workspaceId);
    const textContent = isText ? content : null;
    const binaryData = isText ? null : (content as Uint8Array);
    // Fuse parent existence + parent type + target type validation with
    // the blob and entry upserts. Validation runs as CTEs whose result
    // gates the two INSERTs via WHERE status='ok'; data-modifying CTEs
    // execute exactly once but their SELECT-driven INSERT inserts zero
    // rows when the gate fails. The entry RETURNING (xmax = 0) tells us
    // whether this was an insert or an overwrite, so we can fix the
    // optimistically-incremented node count for the overwrite case.
    let result: { rows: Array<{ status: string; inserted: boolean | null }> };
    try {
      result = await tx.query<{ status: string; inserted: boolean | null }>(
        `WITH lookups AS MATERIALIZED (
           SELECT DISTINCT ON (e.path)
             e.path AS path,
             e.node_type
           FROM fs_entries e
           JOIN version_ancestors a
             ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
           WHERE e.workspace_id = $1
             AND e.path = ANY(ARRAY[$7::ltree, $8::ltree])
             AND a.descendant_id = $6
           ORDER BY e.path, a.depth ASC
         ),
         validation AS (
           SELECT
             CASE
               WHEN COALESCE(
                 (SELECT node_type FROM lookups WHERE path = $7::ltree),
                 'missing'
               ) IN ('missing', 'tombstone')
                 THEN 'enoent'
               WHEN (SELECT node_type FROM lookups WHERE path = $7::ltree) <> 'directory'
                 THEN 'enotdir'
               WHEN COALESCE(
                 (SELECT node_type FROM lookups WHERE path = $8::ltree),
                 ''
               ) = 'directory'
                 THEN 'eisdir'
               ELSE 'ok'
             END AS status
         ),
         blob_upsert AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
           SELECT $1, $2, $3, $4, $5
           FROM validation WHERE status = 'ok'
           ON CONFLICT (workspace_id, hash) DO NOTHING
           RETURNING 1
         ),
         entry_upsert AS (
           INSERT INTO fs_entries
             (workspace_id, version_id, path, blob_hash, node_type,
              symlink_target, mode, size_bytes, mtime)
           SELECT $1, $6, $8::ltree, $2, 'file', NULL, $9, $5, now()
           FROM validation WHERE status = 'ok'
           ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
             blob_hash = EXCLUDED.blob_hash,
             node_type = EXCLUDED.node_type,
             symlink_target = EXCLUDED.symlink_target,
             mode = EXCLUDED.mode,
             size_bytes = EXCLUDED.size_bytes,
             mtime = now()
           RETURNING (xmax = 0) AS inserted
         )
         SELECT validation.status,
                (SELECT inserted FROM entry_upsert) AS inserted
         FROM validation`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          versionId,
          parentLt,
          targetLt,
          0o644,
        ],
      );
    } catch (e) {
      this.decrementCachedNodeCount();
      throw e;
    }

    const row = result.rows[0]!;
    if (row.status !== "ok") {
      this.decrementCachedNodeCount();
      if (row.status === "enoent")
        throw new FsError("ENOENT", "no such file or directory, open", path);
      if (row.status === "enotdir")
        throw new FsError("ENOTDIR", "not a directory, open", path);
      if (row.status === "eisdir")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, open",
          path,
        );
      throw new Error(`internalWriteFile: unexpected status '${row.status}'`);
    }
    if (row.inserted === false) {
      // Overwrite — actual node count didn't change. Undo the optimistic
      // increment so the cache stays accurate.
      this.decrementCachedNodeCount();
    }
  }

  private decrementCachedNodeCount(): void {
    if (this.cachedNodeCount !== null && this.cachedNodeCount > 0) {
      this.cachedNodeCount--;
    }
  }

  protected async blobsHasEmbedding(tx: SqlClient): Promise<boolean> {
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

  protected async maybeEmbed(
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

  protected async internalMkdir(
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

  protected async internalCp(
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
      const existingDest = await this.resolveEntry(tx, dest);
      if (!existingDest) {
        await this.internalMkdir(tx, versionId, dest, { recursive: true });
        const copied = await this.countVisibleSubtreeNodes(tx, versionId, src);
        if (copied.total > this.maxCpNodes) {
          throw new Error(
            `cp: too many nodes (exceeds limit of ${this.maxCpNodes})`,
          );
        }
        if (copied.files > 0) {
          const currentCount = await this.globalVisibleCount(tx, versionId);
          if (currentCount + copied.files > this.maxFiles) {
            throw new Error(
              `Node limit reached: ${this.maxFiles} nodes per workspace`,
            );
          }
        }
        await this.copyVisibleSubtreeEntries(tx, versionId, src, dest, true);
        return;
      }
      if (existingDest.node_type === "directory") {
        const destChildren = await this.listVisibleChildren(tx, dest);
        if (destChildren.length === 0) {
          const copied = await this.countVisibleSubtreeNodes(tx, versionId, src);
          if (copied.total > this.maxCpNodes) {
            throw new Error(
              `cp: too many nodes (exceeds limit of ${this.maxCpNodes})`,
            );
          }
          if (copied.files > 0) {
            const currentCount = await this.globalVisibleCount(tx, versionId);
            if (currentCount + copied.files > this.maxFiles) {
              throw new Error(
                `Node limit reached: ${this.maxFiles} nodes per workspace`,
              );
            }
          }
          await this.copyVisibleSubtreeEntries(tx, versionId, src, dest, false);
          return;
        }
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
}
