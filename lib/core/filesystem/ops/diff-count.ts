import type { SqlParam, VersionDiffCountOptions } from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import { op } from "./context.js";

interface DiffCountRow {
  count: number | string;
}

/**
 * Count changed paths between this version and `other` using the same comparison
 * semantics as `diff()`, but without returning the changed rows.
 */
export const diffCount = op(async (
  ctx,
  other: string,
  opts?: VersionDiffCountOptions,
): Promise<number> => {
  if (other.length === 0) {
    throw new Error("diffCount: other must be a non-empty version label");
  }
  const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
  ctx.guardRead(scopeUser);
  const internalScope = ctx.toInternalPath(scopeUser);
  const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);

  return ctx.withReadOnlyWorkspace(async (tx) => {
    const ourId = await ctx.getCurrentVersionId(tx);
    const theirId = await ctx.requireVersionIdByLabel(tx, other);

    const params: SqlParam[] = [ctx.workspaceId, ourId, theirId, scopeLtree];
    const exc = ctx.buildExcludeClause("e.path", params.length + 1);
    params.push(...exc.params);
    const mnt = ctx.buildMountClause("e.path", params.length + 1);
    params.push(...mnt.params);

    let nodeTypeClause = "";
    if (opts?.nodeType !== undefined) {
      params.push(opts.nodeType);
      nodeTypeClause = `AND (ours.node_type = $${params.length} OR theirs.node_type = $${params.length})`;
    }

    const sql = `
      WITH ours_raw AS (
        SELECT DISTINCT ON (e.path)
          e.path,
          e.node_type,
          e.blob_hash,
          e.symlink_target,
          e.mode
        FROM fs_entries e
        JOIN version_ancestors a
          ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
        WHERE e.workspace_id = $1
          AND a.descendant_id = $2
          AND e.path <@ $4::ltree
          AND ${exc.sql}
          AND ${mnt.sql}
        ORDER BY e.path, a.depth ASC
      ),
      ours AS (SELECT * FROM ours_raw WHERE node_type != 'tombstone'),
      theirs_raw AS (
        SELECT DISTINCT ON (e.path)
          e.path,
          e.node_type,
          e.blob_hash,
          e.symlink_target,
          e.mode
        FROM fs_entries e
        JOIN version_ancestors a
          ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
        WHERE e.workspace_id = $1
          AND a.descendant_id = $3
          AND e.path <@ $4::ltree
          AND ${exc.sql}
          AND ${mnt.sql}
        ORDER BY e.path, a.depth ASC
      ),
      theirs AS (SELECT * FROM theirs_raw WHERE node_type != 'tombstone')
      SELECT COUNT(*) AS count
      FROM ours
      FULL OUTER JOIN theirs USING (path)
      WHERE (
        ours.node_type IS NULL
        OR theirs.node_type IS NULL
        OR ours.node_type != theirs.node_type
        OR ours.mode != theirs.mode
        OR ours.symlink_target IS DISTINCT FROM theirs.symlink_target
        OR ours.blob_hash IS DISTINCT FROM theirs.blob_hash
      )
      ${nodeTypeClause}
    `;

    const result = await tx.query<DiffCountRow>(sql, params);
    return Number(result.rows[0]?.count ?? 0);
  });
});
