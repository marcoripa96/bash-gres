import type {
  SqlClient,
  SqlParam,
  PgFileSystemOptions,
  VersionDiffEntry,
  RenameVersionResult,
  PromoteResult,
  MergeStrategy,
  MergeResult,
  ConflictEntry,
  WorkspaceUsage,
  WorkspaceUsageOptions,
  VersionedDirectoryOptions,
} from "../types.js";
import { FsError } from "../types.js";
import {
  pathToLtree,
  ltreeToPath,
  normalizePath,
  parentPath,
} from "../path-encoding.js";
import { FsBase } from "./base.js";
import {
  TOMBSTONE,
  DEFAULT_VERSION,
  DIFF_DEFAULT_BATCH_SIZE,
  DIFF_MAX_BATCH_SIZE,
  bytesKey,
  entryShapeEqual,
  toPublicEntryShape,
  mapDiffSide,
  classifyDiffChange,
  generatePrevLabel,
  mapVersionLabelUniqueViolation,
  type InternalEntryShape,
  type DiffRow,
  type UsageRow,
} from "./internals.js";

export class FsOps extends FsBase {
  async getUsage(options?: WorkspaceUsageOptions): Promise<WorkspaceUsage> {
    const scopeUser = options?.path ? normalizePath(options.path) : "/";
    this.guardRead(scopeUser);
    const scopeInternal = this.toInternalPath(scopeUser);
    return this.withWorkspace(async (tx) => {
      const versionRootId = await this.getVersionRootId(tx);
      const versionId = await this.getCurrentVersionId(tx);
      const scopeLtree = pathToLtree(scopeInternal, this.workspaceId);
      const baseParams: SqlParam[] = [
        this.workspaceId,
        versionId,
        TOMBSTONE,
        scopeLtree,
        versionRootId,
      ];
      const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
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
             AND ${exc.sql}
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
            (SELECT COUNT(*) FROM fs_versions WHERE workspace_id = $1 AND version_root_id = $5) AS versions,
            (SELECT COUNT(*)
             FROM fs_entries e
             JOIN fs_versions v ON v.workspace_id = e.workspace_id AND v.id = e.version_id
             WHERE e.workspace_id = $1 AND v.version_root_id = $5) AS entry_rows,
            (SELECT COUNT(*)
             FROM fs_entries e
             JOIN fs_versions v ON v.workspace_id = e.workspace_id AND v.id = e.version_id
             WHERE e.workspace_id = $1 AND v.version_root_id = $5 AND e.node_type = $3) AS tombstone_rows,
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
        [...baseParams, ...exc.params],
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

  async versioned(
    path: string,
    options?: VersionedDirectoryOptions,
  ): Promise<this> {
    const internal = this.guardRead(path);
    const version = options?.version ?? DEFAULT_VERSION;
    if (version.length === 0) {
      throw new Error("versioned: version must be a non-empty string");
    }

    let versionRootId: number;
    await this.withWorkspace(async (tx) => {
      const rootLtree = pathToLtree(internal, this.workspaceId);
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree
         LIMIT 1`,
        [this.workspaceId, rootLtree],
      );
      if (r.rows.length === 0) {
        throw new FsError(
          "ENOTVERSIONED",
          "not a versioned directory",
          path,
        );
      }
      versionRootId = Number(r.rows[0]!.id);
    });

    const Ctor = this.constructor as new (opts: PgFileSystemOptions) => this;
    const scoped = new Ctor({
      ...this.baseOptions,
      db: this.rawDb,
      rootDir: internal,
      versionRoot: internal,
      version,
    });
    scoped.cachedVersionRootId = versionRootId!;
    if (this.txClient) {
      scoped.txClient = this.txClient;
      scoped.postCommitHooks = this.postCommitHooks;
      scoped.originInstance = this.originInstance ?? this;
    }
    return scoped;
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
  protected async fetchDiff(
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
    const exc = this.buildExcludeClause("e.path", params.length + 1);
    params.push(...exc.params);
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
          AND ${exc.sql}
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
          AND ${exc.sql}
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

  async fork(newVersion: string): Promise<this> {
    if (!newVersion || newVersion.length === 0) {
      throw new Error("fork: newVersion must be a non-empty string");
    }
    if (newVersion === this.versionLabel) {
      throw new Error(
        `fork: newVersion must differ from current version '${this.versionLabel}'`,
      );
    }

    await this.withWorkspace(async (tx) => {
      const versionRootId = await this.getVersionRootId(tx);
      const parentId = await this.getCurrentVersionId(tx);
      const existing = await tx.query(
        `SELECT 1 FROM fs_versions
         WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3`,
        [this.workspaceId, versionRootId, newVersion],
      );
      if (existing.rows.length > 0) {
        throw new Error(`fork: version '${newVersion}' already exists`);
      }
      const created = await tx.query<{ id: number }>(
        `INSERT INTO fs_versions (workspace_id, version_root_id, label, parent_version_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [this.workspaceId, versionRootId, newVersion, parentId],
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

    const Ctor = this.constructor as new (opts: PgFileSystemOptions) => this;
    const child = new Ctor({
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

  protected async internalDetach(tx: SqlClient): Promise<void> {
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
      const versionRootId = await this.getVersionRootId(tx);
      const r = await tx.query<{ label: string }>(
        `SELECT label FROM fs_versions
         WHERE workspace_id = $1 AND version_root_id = $2
         ORDER BY label`,
        [this.workspaceId, versionRootId],
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
      const versionRootId = await this.getVersionRootId(tx);
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM fs_versions
         WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
         LIMIT 1`,
        [this.workspaceId, versionRootId, version],
      );
      if (r.rows.length === 0) return;
      const targetId = Number(r.rows[0]!.id);
      await this.deleteVersionById(tx, targetId);
    });
  }

  protected async deleteVersionById(
    tx: SqlClient,
    versionId: number,
  ): Promise<void> {
    const children = await tx.query(
      `SELECT 1 FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $3 AND parent_version_id = $2
       LIMIT 1`,
      [this.workspaceId, versionId, await this.getVersionRootId(tx)],
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

  protected async internalRenameVersion(
    tx: SqlClient,
    newLabel: string,
    swap: boolean,
  ): Promise<RenameVersionResult> {
    const versionRootId = await this.getVersionRootId(tx);
    const currentId = await this.getCurrentVersionId(tx);

    // Lock the target label row (if any) so a concurrent rename can't race
    // between our existence check and the UPDATEs below.
    const targetRows = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
       FOR UPDATE`,
      [this.workspaceId, versionRootId, newLabel],
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
  protected expandParentDirectories(
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
  protected async validateBatchNodeCount(
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
}
