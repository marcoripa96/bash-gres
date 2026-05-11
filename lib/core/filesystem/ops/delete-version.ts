import { op } from "./context.js";
import { deleteVersionById } from "./delete-version-by-id.js";

export const deleteVersion = op(async (
  ctx,
  version: string,
): Promise<void> => {
    if (version === ctx.versionLabel) {
      throw new Error(
        `deleteVersion: cannot delete current version '${version}'`,
      );
    }
    await ctx.withWorkspace(async (tx) => {
      const versionRootId = await ctx.getVersionRootId(tx);
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM fs_versions
         WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
           AND deleted_at IS NULL
         LIMIT 1`,
        [ctx.workspaceId, versionRootId, version],
      );
      if (r.rows.length === 0) return;
      const targetId = Number(r.rows[0]!.id);
      await deleteVersionById(ctx, tx, targetId, ctx.historyRetention);
    });
  });
