import type { SqlClient, SweepHistoryResult } from "../../types.js";
import { op, type FilesystemOpsContext } from "./context.js";

interface VersionIdRow {
  id: number | string;
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
    const allRows = await tx.query<VersionIdRow>(
      `SELECT id
       FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2
       ORDER BY id
       FOR UPDATE`,
      [ctx.workspaceId, versionRootId],
    );
    const allIds = allRows.rows.map((row) => Number(row.id));
    if (allIds.length === 0) {
      return {
        keptVersions: 0,
        removedVersions: 0,
        removedEntries: 0,
        removedBlobs: 0,
      };
    }

    const activeRows = await tx.query<VersionIdRow>(
      `SELECT id
       FROM fs_versions
       WHERE workspace_id = $1
         AND version_root_id = $2
         AND deleted_at IS NULL
       ORDER BY id`,
      [ctx.workspaceId, versionRootId],
    );
    const activeIds = activeRows.rows.map((row) => Number(row.id));
    await ctx.lockVersions(tx, allIds);

    for (const versionId of activeIds) {
      await materializeVersion(ctx, tx, versionId);
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

    const inactiveIds = allIds.filter((id) => !activeIds.includes(id));
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

    for (const versionId of activeIds) {
      await tx.query(
        `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
         VALUES ($1, $2, $2, 0)
         ON CONFLICT DO NOTHING`,
        [ctx.workspaceId, versionId],
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

async function materializeVersion<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<void> {
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
    [ctx.workspaceId, versionId],
  );
}
