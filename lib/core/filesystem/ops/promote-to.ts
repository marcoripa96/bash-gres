import type { PromoteResult } from "../../types.js";
import { op } from "./context.js";
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
    if (dropPrevious && ctx.historyRetention === "retain") {
      const result = await ctx.withWorkspace(async (sqlTx) => {
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
            await deleteVersionById(ctx, sqlTx, Number(previous.rows[0]!.id), "retain");
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
      if (dropPrevious && renamed.displacedLabel) {
        await tx.deleteVersion(renamed.displacedLabel);
      }
      return {
        label: renamed.label,
        displacedLabel: dropPrevious ? undefined : renamed.displacedLabel,
        droppedPrevious: Boolean(dropPrevious && renamed.displacedLabel),
      };
    });
  });
