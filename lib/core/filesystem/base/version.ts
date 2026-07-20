import type { SqlClient, SqlParam } from "../../types.js";
import { FsError } from "../../types.js";
import { pathToLtree } from "../../path-encoding.js";
import { DEFAULT_VERSION, TOMBSTONE } from "../internals/constants.js";
import type { VersionRootRow } from "../internals/rows.js";
import { FsStateBase } from "./state.js";

export class FsVersionBase extends FsStateBase {
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
          AND deleted_at IS NULL
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
    if (this.requestedVersionId !== null) {
      const rootLtree = pathToLtree(this.versionRootPath, this.workspaceId);
      const requested = await tx.query<{
        id: number;
        label: string;
        version_root_id: number;
      }>(
        `SELECT v.id, v.label, v.version_root_id
           FROM fs_versions v
           JOIN fs_version_roots r
             ON r.workspace_id = v.workspace_id
            AND r.id = v.version_root_id
          WHERE v.workspace_id = $1
            AND v.id = $2
            AND r.path = $3::ltree
          LIMIT 1`,
        [this.workspaceId, this.requestedVersionId, rootLtree],
      );
      const row = requested.rows[0];
      if (!row) {
        throw new Error(
          `Version id '${this.requestedVersionId}' does not exist in version root '${this.versionRootPath}' of workspace '${this.workspaceId}'.`,
        );
      }
      this.cachedVersionId = Number(row.id);
      this.cachedVersionRootId = Number(row.version_root_id);
      this.versionLabel = row.label;
      return this.cachedVersionId;
    }
    const versionRootId = await this.getVersionRootId(tx);
    const r = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
        WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
          AND deleted_at IS NULL
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
    if (this.requestedVersionId !== null) {
      return this.getCurrentVersionId(tx);
    }
    const versionRootId = await this.getVersionRootId(tx);
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM fs_versions
        WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
          AND deleted_at IS NULL
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
    this.cachedNodeCount = 0;
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
          AND deleted_at IS NULL
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
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT DISTINCT ON (e.path) e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
          WHERE e.workspace_id = $1 AND a.descendant_id = $2
            AND ${exc.sql}
            AND ${mnt.sql}
          ORDER BY e.path, a.depth ASC
        ) v WHERE node_type != $3`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    return Number(r.rows[0]?.count ?? 0);
  }
}
