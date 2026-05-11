import type { PromoteResult, SqlClient } from "../../types.js";
import { op, type FilesystemOpsContext } from "./context.js";
import { deleteVersionById } from "./delete-version-by-id.js";
import { renameVersionInTransaction } from "./rename-version.js";

/**
 * Promote the current version to a label. With `dropPrevious`, behave like
 * moving a git branch: the displaced label is hidden, but its version row,
 * entries, and ancestor links are retained so the promoted version can still
 * expose history through its parent chain.
 */
export const promoteTo = op(async (
  ctx,
  label: string,
  opts?: { dropPrevious?: boolean },
): Promise<PromoteResult> => {
    if (!label || label.length === 0) {
      throw new Error("promoteTo: label must be a non-empty string");
    }
    const dropPrevious = opts?.dropPrevious ?? false;
    if (dropPrevious) {
      const result = await ctx.withWorkspace(async (sqlTx) => {
        const currentId = await ctx.getCurrentVersionId(sqlTx);
        await materializeCurrentVersion(ctx, sqlTx, currentId);
        const renamed = await renameVersionInTransaction(ctx, sqlTx, label, true);
        if (renamed.displacedLabel) {
          const previous = await sqlTx.query<{ id: number }>(
            `SELECT id FROM fs_versions
             WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
               AND deleted_at IS NULL
             LIMIT 1`,
            [ctx.workspaceId, await ctx.getVersionRootId(sqlTx), renamed.displacedLabel],
          );
          if (previous.rows.length > 0) {
            await deleteVersionById(ctx, sqlTx, Number(previous.rows[0]!.id));
          }
        }
        return {
          label: renamed.label,
          droppedPrevious: Boolean(renamed.displacedLabel),
        };
      });
      ctx.setVersionLabelAfterRename(result.label);
      return result;
    }

    return ctx.transaction(async (tx) => {
      await tx.detach();
      const renamed = await tx.renameVersion(label, { swap: true });
      return {
        label: renamed.label,
        displacedLabel: renamed.displacedLabel,
        droppedPrevious: false,
      };
    });
  });

async function materializeCurrentVersion<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<void> {
  await ctx.lockVersions(tx, [versionId]);
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
