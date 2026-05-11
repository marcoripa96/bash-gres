import type { SqlClient, SweepHistoryResult } from "../../types.js";
import { op, type FilesystemOpsContext } from "./context.js";

interface VersionIdRow {
  id: number | string;
  deleted_at: Date | string | null;
}

interface CountRow {
  count: number | string;
}

/**
 * Destructively remove retained history for the active version root. Active
 * labels are first materialized as standalone snapshots, then all deleted
 * versions are physically removed and active parent links are cleared.
 */
export const sweepHistory = op(async (
  ctx,
): Promise<SweepHistoryResult> => {
  return ctx.withWorkspace(async (tx) => {
    const versionRootId = await ctx.getVersionRootId(tx);
    const versionRows = await tx.query<VersionIdRow>(
      `SELECT id, deleted_at
       FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2
       ORDER BY id
       FOR UPDATE`,
      [ctx.workspaceId, versionRootId],
    );
    const allIds = versionRows.rows.map((row) => Number(row.id));
    if (allIds.length === 0) {
      return {
        keptVersions: 0,
        removedVersions: 0,
        removedEntries: 0,
        removedBlobs: 0,
      };
    }

    const activeIds = versionRows.rows
      .filter((row) => row.deleted_at === null)
      .map((row) => Number(row.id));
    const activeIdSet = new Set(activeIds);
    await ctx.lockVersions(tx, allIds);

    if (activeIds.length > 0) {
      await materializeVersionsBatch(ctx, tx, activeIds);
    }

    if (activeIds.length > 0) {
      await tx.query(
        `DELETE FROM fs_entries
         WHERE workspace_id = $1
           AND version_id = ANY($2::bigint[])
           AND node_type = 'tombstone'`,
        [ctx.workspaceId, activeIds],
      );
      await tx.query(
        `UPDATE fs_versions
         SET parent_version_id = NULL
         WHERE workspace_id = $1
           AND id = ANY($2::bigint[])`,
        [ctx.workspaceId, activeIds],
      );
    }

    const inactiveIds = allIds.filter((id) => !activeIdSet.has(id));
    let removedEntries = 0;
    let removedVersions = 0;
    if (inactiveIds.length > 0) {
      const deletedEntries = await tx.query<CountRow>(
        `WITH deleted AS (
           DELETE FROM fs_entries
           WHERE workspace_id = $1
             AND version_id = ANY($2::bigint[])
           RETURNING 1
         )
         SELECT COUNT(*) AS count FROM deleted`,
        [ctx.workspaceId, inactiveIds],
      );
      removedEntries = Number(deletedEntries.rows[0]?.count ?? 0);
    }

    await tx.query(
      `DELETE FROM version_ancestors
       WHERE workspace_id = $1
         AND (descendant_id = ANY($2::bigint[]) OR ancestor_id = ANY($2::bigint[]))`,
      [ctx.workspaceId, allIds],
    );

    if (inactiveIds.length > 0) {
      const deletedVersions = await tx.query<CountRow>(
        `WITH deleted AS (
           DELETE FROM fs_versions
           WHERE workspace_id = $1
             AND id = ANY($2::bigint[])
           RETURNING 1
         )
         SELECT COUNT(*) AS count FROM deleted`,
        [ctx.workspaceId, inactiveIds],
      );
      removedVersions = Number(deletedVersions.rows[0]?.count ?? 0);
    }

    if (activeIds.length > 0) {
      await tx.query(
        `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
         SELECT $1, id, id, 0 FROM unnest($2::bigint[]) AS t(id)
         ON CONFLICT DO NOTHING`,
        [ctx.workspaceId, activeIds],
      );
    }

    const deletedBlobs = await tx.query<CountRow>(
      `WITH deleted AS (
         DELETE FROM fs_blobs b
         WHERE b.workspace_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM fs_entries e
             WHERE e.workspace_id = b.workspace_id
               AND e.blob_hash = b.hash
           )
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [ctx.workspaceId],
    );

    return {
      keptVersions: activeIds.length,
      removedVersions,
      removedEntries,
      removedBlobs: Number(deletedBlobs.rows[0]?.count ?? 0),
    };
  });
});

/**
 * Materialize all `activeIds` in a single SQL statement: for each
 * (descendant_id, path) pair across the active set, pick the deepest
 * ancestor's row (`ROW_NUMBER() ... ORDER BY depth ASC`), skip the cases
 * where the deepest source is the descendant itself (already physically
 * present) or a tombstone, and insert the rest under the descendant's
 * version_id. Replaces N round-trips × N full-tree scans.
 */
async function materializeVersionsBatch<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  activeIds: number[],
): Promise<void> {
  await tx.query(
    `WITH version_bump AS (
       UPDATE fs_versions SET last_write_at = now()
       WHERE workspace_id = $1 AND id = ANY($2::bigint[])
       RETURNING 1
     )
     INSERT INTO fs_entries (
       workspace_id, version_id, path, blob_hash, node_type,
       symlink_target, mode, size_bytes, mtime, created_at
     )
     SELECT
       $1, src.descendant_id,
       src.path, src.blob_hash, src.node_type,
       src.symlink_target, src.mode, src.size_bytes, src.mtime, now()
     FROM (
       SELECT
         a.descendant_id,
         e.path, e.blob_hash, e.node_type, e.symlink_target,
         e.mode, e.size_bytes, e.mtime, e.version_id AS source_version_id,
         ROW_NUMBER() OVER (
           PARTITION BY a.descendant_id, e.path
           ORDER BY a.depth ASC
         ) AS rn
       FROM version_ancestors a
       JOIN fs_entries e
         ON e.workspace_id = a.workspace_id
        AND e.version_id = a.ancestor_id
       WHERE a.workspace_id = $1
         AND a.descendant_id = ANY($2::bigint[])
     ) src
     WHERE src.rn = 1
       AND src.source_version_id <> src.descendant_id
       AND src.node_type <> 'tombstone'
     ON CONFLICT (workspace_id, version_id, path) DO NOTHING`,
    [ctx.workspaceId, activeIds],
  );
}
