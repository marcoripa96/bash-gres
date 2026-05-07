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
      // Single-statement fork: the duplicate-label guard, the new version
      // INSERT, and both ancestor-closure INSERTs run as data-modifying CTEs
      // in one round-trip. Per Postgres semantics every data-modifying CTE
      // executes exactly once even if unreferenced, so the two ancestor
      // INSERTs always run; they each cross-join `new_version`, so when
      // `existing` already has a row `new_version` returns zero rows and
      // both ancestor INSERTs become no-ops.
      const r = await tx.query<{ new_id: number | null; existing_id: number | null }>(
        `WITH existing AS (
           SELECT id FROM fs_versions
           WHERE workspace_id = $1 AND version_root_id = $2 AND label = $3
           LIMIT 1
         ),
         new_version AS (
           INSERT INTO fs_versions (workspace_id, version_root_id, label, parent_version_id)
           SELECT $1, $2, $3, $4
           WHERE NOT EXISTS (SELECT 1 FROM existing)
           RETURNING id
         ),
         parent_ancestors AS (
           INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
           SELECT $1, nv.id, a.ancestor_id, a.depth + 1
           FROM new_version nv
           JOIN version_ancestors a
             ON a.workspace_id = $1 AND a.descendant_id = $4
           RETURNING 1
         ),
         self_ancestor AS (
           INSERT INTO version_ancestors (workspace_id, descendant_id, ancestor_id, depth)
           SELECT $1, nv.id, nv.id, 0 FROM new_version nv
           RETURNING 1
         )
         SELECT
           (SELECT id FROM new_version)::bigint AS new_id,
           (SELECT id FROM existing)::bigint AS existing_id`,
        [ctx.workspaceId, versionRootId, newVersion, parentId],
      );
      const row = r.rows[0]!;
      if (row.existing_id !== null) {
        throw new Error(`fork: version '${newVersion}' already exists`);
      }
      if (row.new_id === null) {
        throw new Error(`fork: failed to create version '${newVersion}'`);
      }
    });

    return ctx.createForkedFilesystem(newVersion);
  });
