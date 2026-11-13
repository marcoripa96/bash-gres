import type { SweepHistoryResult } from "../../types.js";
import { op } from "./context.js";
import { copyInheritedEntries } from "./inherited-entries.js";

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
      await copyInheritedEntries(ctx, tx, activeIds, { bumpLastWrite: true });
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
    // Sweeping flattens history (active parents are cleared below), so
    // merge records in this root go too.
    await tx.query(
      `DELETE FROM fs_version_merges
       WHERE workspace_id = $1
         AND (version_id = ANY($2::bigint[]) OR source_id = ANY($2::bigint[]))`,
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
