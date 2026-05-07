import type { RenameVersionResult, SqlClient } from "../../types.js";
import {
  generatePrevLabel,
  mapVersionLabelUniqueViolation,
} from "../internals/version-labels.js";
import { op, type FilesystemOpsContext } from "./context.js";

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
export const renameVersion = op(async (
  ctx,
  newLabel: string,
  opts?: { swap?: boolean },
): Promise<RenameVersionResult> => {
  if (!newLabel || newLabel.length === 0) {
    throw new Error("renameVersion: newLabel must be a non-empty string");
  }
  if (newLabel === ctx.versionLabel) {
    return { label: newLabel };
  }
  const swap = opts?.swap ?? false;
  const result = await ctx.withWorkspace((tx) =>
    renameVersionInTransaction(ctx, tx, newLabel, swap),
  );
  // Update the active label on this instance. For top-level calls the SQL
  // has already committed; for tx-bound facades it has not, but the facade
  // is single-shot and is discarded when the outer transaction resolves.
  // The `cachedVersionId` is left intact: the version ID didn't move.
  ctx.setVersionLabelAfterRename(result.label);
  return result;
});

async function renameVersionInTransaction<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  newLabel: string,
  swap: boolean,
): Promise<RenameVersionResult> {
  const versionRootId = await ctx.getVersionRootId(tx);
  const currentId = await ctx.getCurrentVersionId(tx);

  // Lock the target label row (if any) so a concurrent rename can't race
  // between our existence check and the UPDATEs below.
  const targetRows = await tx.query<{ id: number }>(
    `SELECT id FROM fs_versions
     WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
     FOR UPDATE`,
    [ctx.workspaceId, versionRootId, newLabel],
  );

  if (targetRows.rows.length === 0) {
    await ctx.lockVersions(tx, [currentId]);
    try {
      await tx.query(
        `UPDATE fs_versions SET label = $3
         WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, currentId, newLabel],
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

  await ctx.lockVersions(tx, [currentId, targetId]);

  const displacedLabel = generatePrevLabel(newLabel, targetId);
  try {
    await tx.query(
      `UPDATE fs_versions SET label = $3
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, targetId, displacedLabel],
    );
  } catch (e) {
    throw mapVersionLabelUniqueViolation(e, displacedLabel);
  }
  try {
    await tx.query(
      `UPDATE fs_versions SET label = $3
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, currentId, newLabel],
    );
  } catch (e) {
    throw mapVersionLabelUniqueViolation(e, newLabel);
  }
  return { label: newLabel, displacedLabel };
}
