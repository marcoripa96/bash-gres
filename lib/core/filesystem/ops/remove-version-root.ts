import type { SqlClient } from "../../types.js";
import { pathToLtree } from "../../path-encoding.js";
import { op } from "./context.js";

/**
 * Hard-delete the version root at `internalPath` and every artifact it owns:
 * all fs_versions rows for that root, their version_ancestors closure, all
 * fs_entries written under those versions, and any fs_blobs that become
 * unreferenced. Then drop the fs_version_roots row itself.
 *
 * Caller is responsible for tombstoning the path in the outer/parent
 * namespace if visibility there also needs to be cleared — this op only
 * tears down the version root and never touches the parent fs's version.
 *
 * Returns true if a version root was found and removed, false if none
 * existed at the path.
 */
export const removeVersionRoot = op(async (
  ctx,
  tx: SqlClient,
  internalPath: string,
): Promise<boolean> => {
    const rootLtree = pathToLtree(internalPath, ctx.workspaceId);
    const found = await tx.query<{ id: number }>(
      `SELECT id FROM fs_version_roots
       WHERE workspace_id = $1 AND path = $2::ltree
       LIMIT 1`,
      [ctx.workspaceId, rootLtree],
    );
    if (found.rows.length === 0) return false;
    const versionRootId = Number(found.rows[0]!.id);

    // Break the self-referential parent_version_id chain so the bulk DELETE
    // doesn't fight ON DELETE RESTRICT row-by-row.
    await tx.query(
      `UPDATE fs_versions
       SET parent_version_id = NULL
       WHERE workspace_id = $1 AND version_root_id = $2`,
      [ctx.workspaceId, versionRootId],
    );

    await tx.query(`DROP TABLE IF EXISTS pg_temp.bash_gres_blob_gc_candidates`);
    await tx.query(
      `CREATE TEMP TABLE pg_temp.bash_gres_blob_gc_candidates (
         hash bytea PRIMARY KEY
       ) ON COMMIT DROP`,
    );

    await tx.query(
      `INSERT INTO pg_temp.bash_gres_blob_gc_candidates (hash)
       SELECT DISTINCT blob_hash
       FROM fs_entries
       WHERE workspace_id = $1
         AND version_id IN (
           SELECT id FROM fs_versions
           WHERE workspace_id = $1 AND version_root_id = $2
         )
         AND blob_hash IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [ctx.workspaceId, versionRootId],
    );

    await tx.query(
      `DELETE FROM fs_entries
       WHERE workspace_id = $1
         AND version_id IN (
           SELECT id FROM fs_versions
           WHERE workspace_id = $1 AND version_root_id = $2
         )`,
      [ctx.workspaceId, versionRootId],
    );

    await tx.query(
      `DELETE FROM version_ancestors
       WHERE workspace_id = $1
         AND (
           descendant_id IN (
             SELECT id FROM fs_versions
             WHERE workspace_id = $1 AND version_root_id = $2
           )
           OR ancestor_id IN (
             SELECT id FROM fs_versions
             WHERE workspace_id = $1 AND version_root_id = $2
           )
         )`,
      [ctx.workspaceId, versionRootId],
    );

    await tx.query(
      `DELETE FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2`,
      [ctx.workspaceId, versionRootId],
    );

    await tx.query(
      `DELETE FROM fs_version_roots
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, versionRootId],
    );

    await tx.query(
      `DELETE FROM fs_blobs b
       USING pg_temp.bash_gres_blob_gc_candidates c
       WHERE b.workspace_id = $1
         AND b.hash = c.hash
         AND NOT EXISTS (
            SELECT 1 FROM fs_entries
            WHERE workspace_id = $1 AND blob_hash = c.hash
          )`,
      [ctx.workspaceId],
    );

    return true;
  });
