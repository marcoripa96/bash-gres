import { randomUUID } from "crypto";
import type { ChunkingOptions } from "../../chunking.js";
import type { PgFileSystemOptions, SqlClient, SqlParam } from "../../types.js";
import { FsError, SqlError } from "../../types.js";
import { readonlySqlClient } from "../../readonly.js";
import { normalizePath } from "../../path-encoding.js";
import {
  compileExcludes,
  excludeWhereSql,
  isExcluded,
  type CompiledExcludes,
} from "../../exclude.js";
import {
  compileMounts,
  mountVisible,
  mountWritable,
  mountWhereSql,
  type CompiledMounts,
} from "../../mounts.js";
import {
  DEFAULT_MAX_CP_NODES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_SYMLINK_DEPTH,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_VERSION,
} from "../internals/constants.js";

export class FsStateBase {
  protected client: SqlClient;
  /**
   * The value the adapter wants threaded back into its own constructor when the
   * core needs to reconstruct a sibling instance (fork, scope, tx facade). For
   * raw `CorePgFileSystem` consumers this is the same `SqlClient` as `client`;
   * for adapters (drizzle, node-postgres, postgres-js) it is the original
   * un-wrapped user db so the adapter constructor's `createXClient(options.db)`
   * runs exactly once per chain. Storing the wrapped `SqlClient` here would
   * make adapter forks wrap a `SqlClient` again, producing a client that
   * dispatches to a non-existent `db.execute` and crashes on first query.
   */
  protected rawDb: unknown;
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
  /** Chunk-level index options; null when the `chunking` option is off. */
  protected chunking: ChunkingOptions | null;
  protected historyRetention: "retain" | "discard";
  protected rootDir: string;
  protected versionRootPath: string;
  protected excludes: CompiledExcludes;
  protected mounts: CompiledMounts;
  protected readonly baseOptions: PgFileSystemOptions;
  protected requestedVersionId: number | null = null;
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
    if (options.version !== undefined && options.versionId !== undefined) {
      throw new Error("version and versionId are mutually exclusive");
    }
    if (
      options.versionId !== undefined &&
      (!Number.isSafeInteger(options.versionId) || options.versionId <= 0)
    ) {
      throw new Error("versionId must be a positive safe integer");
    }
    if (options.versionId !== undefined && options.permissions?.write !== false) {
      throw new Error("versionId requires permissions.write to be false");
    }
    const perms = {
      read: options.permissions?.read ?? true,
      write: options.permissions?.write ?? true,
    };
    this.permissions = perms;
    this.rawDb = options.db;
    this.client = perms.write ? options.db : readonlySqlClient(options.db);
    this.workspaceId = options.workspaceId ?? randomUUID();
    this.versionLabel = options.version ?? DEFAULT_VERSION;
    this.requestedVersionId = options.versionId ?? null;
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
    this.chunking = options.chunking
      ? options.chunking === true
        ? {}
        : options.chunking
      : null;
    this.historyRetention = options.historyRetention ?? "discard";
    this.rootDir = normalizePath(options.rootDir ?? "/");
    this.versionRootPath = normalizePath(options.versionRoot ?? "/");
    this.excludes = compileExcludes(
      options.exclude,
      this.rootDir,
      this.workspaceId,
    );
    this.mounts = compileMounts(options.mount, this.rootDir, this.workspaceId);
    this.baseOptions = {
      ...options,
      workspaceId: this.workspaceId,
      versionRoot: this.versionRootPath,
      historyRetention: this.historyRetention,
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
      // `rawDb` is opaque to the core — it's whatever the adapter stored as the
      // input it wants to receive again. The cast satisfies the static
      // signature; the runtime type matches the adapter's constructor input.
      db: this.rawDb as SqlClient,
      // Use the live label, not the construction-time one, so a facade created
      // after a successful renameVersion() still points at the right version.
      version:
        this.requestedVersionId === null ? this.versionLabel : undefined,
      versionId: this.requestedVersionId ?? undefined,
    });
    facade.txClient = sqlTx;
    facade.cachedVersionId = this.cachedVersionId;
    facade.cachedVersionRootId = this.cachedVersionRootId;
    facade.postCommitHooks = postCommitHooks;
    facade.originInstance = this;
    return facade;
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
    const internal = this.toInternalPath(normalizePath(userPath));
    if (!this.mounts.empty) {
      // Out-of-scope writes look like the path doesn't exist; in-scope but
      // read-only (a readonly mount, or an ancestor passthrough dir) is a
      // permission error.
      if (!mountVisible(this.mounts, internal)) {
        throw new FsError("ENOENT", "no such file or directory", userPath);
      }
      if (!mountWritable(this.mounts, internal)) {
        throw new FsError("EACCES", "permission denied", userPath);
      }
    }
    return internal;
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
   * Build the SQL fragment that restricts a result set to mounted subtrees and
   * the ancestor paths leading to them. `{ sql: "TRUE", params: [] }` when this
   * instance has no mounts. Threaded into every directory-listing, walk, glob,
   * and search query alongside `buildExcludeClause`.
   */
  protected buildMountClause(
    pathExpr: string,
    nextParamIdx: number,
  ): { sql: string; params: SqlParam[] } {
    return mountWhereSql(this.mounts, pathExpr, nextParamIdx);
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
    if (!this.mounts.empty) {
      // With mounts, the boundary is the union of visible subtrees rather than
      // a single contiguous rootDir.
      if (!mountVisible(this.mounts, internalPath)) {
        throw new FsError(
          "EACCES",
          "symlink target outside mount boundary",
          this.toUserPath(internalPath),
        );
      }
      return;
    }
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
}
