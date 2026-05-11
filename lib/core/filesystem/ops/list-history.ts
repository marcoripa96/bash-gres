import type {
  SqlClient,
  SqlParam,
  VersionDiffEntry,
  VersionHistoryEntry,
  VersionHistoryOptions,
} from "../../types.js";
import { ltreeToPath, normalizePath, pathToLtree } from "../../path-encoding.js";
import { mapDiffSide } from "../internals/entry-shapes.js";
import { op, type FilesystemOpsContext } from "./context.js";
import { fetchDiff } from "./fetch-diff.js";

interface HistoryVersionRow {
  id: number | string;
  label: string;
  parent_version_id: number | string | null;
  parent_label: string | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
}

interface RootEntryRow {
  path: string;
  node_type: string;
  blob_hash: Uint8Array | null;
  symlink_target: string | null;
  mode: number;
  size_bytes: number | string;
  mtime: Date | string;
}

export const listHistory = op(async (
  ctx,
  opts?: VersionHistoryOptions,
): Promise<VersionHistoryEntry[]> => {
  const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
  ctx.guardRead(scopeUser);
  const internalScope = ctx.toInternalPath(scopeUser);
  const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
  const includeRoot = opts?.includeRoot ?? true;

  return ctx.withReadOnlyWorkspace(async (tx) => {
    const versionRootId = await ctx.getVersionRootId(tx);
    const currentId = await ctx.getCurrentVersionId(tx);
    const versions = await tx.query<HistoryVersionRow>(
      `SELECT
         v.id,
         v.label,
         v.parent_version_id,
         p.label AS parent_label,
         v.created_at,
         v.deleted_at
       FROM version_ancestors a
       JOIN fs_versions v
         ON v.workspace_id = a.workspace_id
        AND v.id = a.ancestor_id
       LEFT JOIN fs_versions p
         ON p.workspace_id = v.workspace_id
        AND p.id = v.parent_version_id
       WHERE a.workspace_id = $1
         AND a.descendant_id = $2
         AND v.version_root_id = $3
       ORDER BY a.depth ASC
       LIMIT $4`,
      [ctx.workspaceId, currentId, versionRootId, limit],
    );

    const entries: VersionHistoryEntry[] = [];
    for (const row of versions.rows) {
      const versionId = Number(row.id);
      const parentVersionId =
        row.parent_version_id === null ? null : Number(row.parent_version_id);
      if (parentVersionId === null && !includeRoot) continue;
      const changes = parentVersionId === null
        ? await fetchRootAdds(ctx, tx, versionId, scopeLtree)
        : (await fetchDiff(ctx, tx, parentVersionId, versionId, scopeLtree, null)).entries;

      entries.push({
        versionId,
        version: row.label,
        parentVersionId,
        parentVersion: row.parent_label,
        createdAt: new Date(row.created_at),
        deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
        changes,
      });
    }
    return entries;
  });
});

async function fetchRootAdds<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
  scopeLtree: string,
): Promise<VersionDiffEntry[]> {
  const params: SqlParam[] = [ctx.workspaceId, versionId, scopeLtree];
  const exc = ctx.buildExcludeClause("e.path", params.length + 1);
  params.push(...exc.params);
  const result = await tx.query<RootEntryRow>(
    `WITH visible_raw AS (
       SELECT DISTINCT ON (e.path)
         e.path,
         e.node_type,
         e.blob_hash,
         e.symlink_target,
         e.mode,
         e.size_bytes,
         e.mtime
       FROM fs_entries e
       JOIN version_ancestors a
         ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
       WHERE e.workspace_id = $1
         AND a.descendant_id = $2
         AND e.path <@ $3::ltree
         AND ${exc.sql}
       ORDER BY e.path, a.depth ASC
     )
     SELECT * FROM visible_raw
     WHERE node_type != 'tombstone'
     ORDER BY path`,
    params,
  );

  return result.rows.map((row) => ({
    path: ctx.toUserPath(ltreeToPath(row.path)),
    change: "added",
    before: null,
    after: mapDiffSide(
      row.node_type,
      row.blob_hash,
      row.symlink_target,
      row.mode,
      row.size_bytes,
      new Date(row.mtime),
    ),
  }));
}
