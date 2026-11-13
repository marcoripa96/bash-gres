import type { SqlClient } from "../../types.js";
import { op, type FilesystemOpsContext } from "./context.js";

/**
 * Copy into the current version every entry it inherits from its ancestors,
 * then cut its ancestor-closure rows, so it stops reading through (and
 * paying for) its ancestor chain. Unlike `detach()`, it keeps
 * `parent_version_id` and the version's tombstones: `listHistory`,
 * `versionDiff` and merge bases still pass through it, and a fork of it
 * costs two closure rows however long the history behind it.
 *
 * What the version and its descendants show does not change. Works on a
 * frozen version (no content changes, no `last_write_at` bump). Idempotent.
 * Cost: O(visible entries) + O(versions in the version's subtree).
 */
export const materialize = op(async (ctx): Promise<void> => {
  await ctx.withWorkspace(async (tx) => {
    await materializeVersion(ctx, tx, await ctx.getCurrentVersionId(tx));
  });
});

export async function materializeVersion<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<void> {
  // Subtree of V (V included through its self row): closure rows from these
  // to V's ancestors are the ones that go.
  const sub = await tx.query<{ id: number | string }>(
    `SELECT descendant_id AS id
     FROM version_ancestors
     WHERE workspace_id = $1 AND ancestor_id = $2
     ORDER BY descendant_id`,
    [ctx.workspaceId, versionId],
  );
  const subtreeIds = sub.rows.map((r) => Number(r.id));
  if (subtreeIds.length > 0) {
    await tx.query(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND id = ANY($2::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [ctx.workspaceId, subtreeIds],
    );
    await ctx.lockVersions(tx, subtreeIds);
  }

  // Nearest-ancestor row per path; V's own rows (tombstones included) stay.
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

  if (subtreeIds.length > 0) {
    await tx.query(
      `DELETE FROM version_ancestors
       WHERE workspace_id = $1
         AND descendant_id = ANY($2::bigint[])
         AND NOT (ancestor_id = ANY($2::bigint[]))`,
      [ctx.workspaceId, subtreeIds],
    );
  }
}
