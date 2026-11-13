import type { PromoteOptions, PromoteResult } from "../../types.js";
import { op } from "./context.js";
import { deleteVersionById } from "./delete-version-by-id.js";
import { freezeVersion } from "./freeze.js";
import { materializeVersion } from "./materialize.js";
import { renameVersionInTransaction } from "./rename-version.js";

/**
 * Promote the current version to a label. With `dropPrevious`, behave like
 * moving a git branch: the displaced label is hidden, but its version row,
 * entries, and ancestor links are retained so the promoted version can still
 * expose history through its parent chain.
 *
 * `freeze` and `materialize` apply to the promoted version inside the same
 * transaction: a publish that must never change again and must not read
 * through (or pay for) the chain behind it.
 */
export const promoteTo = op(async (
  ctx,
  label: string,
  opts?: PromoteOptions,
): Promise<PromoteResult> => {
    if (!label || label.length === 0) {
      throw new Error("promoteTo: label must be a non-empty string");
    }
    const dropPrevious = opts?.dropPrevious ?? false;
    if (opts?.materialize && ctx.historyRetention !== "retain") {
      throw new Error(
        'promoteTo: materialize requires historyRetention "retain" (under "discard" promotion detaches)',
      );
    }
    // Retained history without detaching: dropPrevious keeps the displaced
    // version as history; materialize replaces the detach outright.
    if (ctx.historyRetention === "retain" && (dropPrevious || opts?.materialize)) {
      const result = await ctx.withWorkspace(async (sqlTx) => {
        const currentId = await ctx.getCurrentVersionId(sqlTx);
        if (opts?.materialize) await materializeVersion(ctx, sqlTx, currentId);
        if (!dropPrevious) {
          const renamed = await renameVersionInTransaction(ctx, sqlTx, label, true);
          if (opts?.freeze) await freezeVersion(ctx, sqlTx, currentId);
          return {
            label: renamed.label,
            displacedLabel: renamed.displacedLabel,
            droppedPrevious: false,
          };
        }
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
        if (opts?.freeze) await freezeVersion(ctx, sqlTx, currentId);
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
      if (opts?.freeze) await tx.freeze();
      return {
        label: renamed.label,
        displacedLabel: dropPrevious ? undefined : renamed.displacedLabel,
        droppedPrevious: Boolean(dropPrevious && renamed.displacedLabel),
      };
    });
  });
