import { op } from "./context.js";

export const fork = op(async (
  ctx,
  newVersion: string,
) => {
    if (!newVersion || newVersion.length === 0) {
      throw new Error("fork: newVersion must be a non-empty string");
    }
    if (newVersion === ctx.versionLabel) {
      throw new Error(
        `fork: newVersion must differ from current version '${ctx.versionLabel}'`,
      );
    }

    await ctx.withWorkspace(async (tx) => {
      const versionRootId = await ctx.getVersionRootId(tx);
      const parentId = await ctx.getCurrentVersionId(tx);
      const existing = await tx.query(
        `SELECT 1 FROM fs_versions
         WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3`,
        [ctx.workspaceId, versionRootId, newVersion],
      );
      if (existing.rows.length > 0) {
        throw new Error(`fork: version '${newVersion}' already exists`);
      }
      const created = await tx.query<{ id: number }>(
        `INSERT INTO fs_versions (workspace_id, version_root_id, label, parent_version_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [ctx.workspaceId, versionRootId, newVersion, parentId],
      );
      const newId = Number(created.rows[0]!.id);
      await tx.query(
        `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
         SELECT $1, $2, ancestor_id, depth + 1
         FROM version_ancestors
         WHERE workspace_id = $1 AND descendant_id = $3`,
        [ctx.workspaceId, newId, parentId],
      );
      await tx.query(
        `INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
         VALUES ($1, $2, $2, 0)`,
        [ctx.workspaceId, newId],
      );
    });

    return ctx.createForkedFilesystem(newVersion);
  });
