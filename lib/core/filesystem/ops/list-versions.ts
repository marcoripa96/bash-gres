import { op } from "./context.js";

export const listVersions = op(async (ctx): Promise<string[]> => {
    return ctx.withReadOnlyWorkspace(async (tx) => {
      const versionRootId = await ctx.getVersionRootId(tx);
      const r = await tx.query<{ label: string }>(
        `SELECT label FROM fs_versions
         WHERE workspace_id = $1 AND version_root_id = $2
         ORDER BY label`,
        [ctx.workspaceId, versionRootId],
      );
      return r.rows.map((row) => row.label);
    });
  });
