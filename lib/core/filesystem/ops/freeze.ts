import type { SqlClient } from "../../types.js";
import { op, type FilesystemOpsContext } from "./context.js";

/**
 * Freeze the current version: from now on every content write to it is
 * refused with `EPERM`, whichever handle issues it (a `fs_versions` trigger
 * refuses the `last_write_at` bump every write makes). Idempotent; there is
 * no unfreeze. Label moves (`renameVersion`, `promoteTo`), soft deletion,
 * `fork`, `materialize`, `compactHistory` and removing the version root
 * still work: they do not change what the version contains.
 *
 * Freeze a version before others build on it (a published version that
 * forks overlay and merges use as their base): an unfrozen parent's later
 * writes show through in its forks and move the base of later merges.
 */
export const freeze = op(async (ctx): Promise<void> => {
  await ctx.withWorkspace(async (tx) => {
    await freezeVersion(ctx, tx, await ctx.getCurrentVersionId(tx));
  });
});

export async function freezeVersion<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<void> {
  // The row lock waits for in-flight writes to this version (each holds it
  // through its last_write_at bump); writes queued behind it see frozen_at.
  await tx.query(
    `UPDATE fs_versions SET frozen_at = COALESCE(frozen_at, now())
     WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, versionId],
  );
}
