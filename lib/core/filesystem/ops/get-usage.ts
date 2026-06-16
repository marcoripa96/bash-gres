import type { SqlParam, WorkspaceUsage, WorkspaceUsageOptions } from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import { TOMBSTONE } from "../internals/constants.js";
import type { UsageRow } from "../internals/rows.js";
import { op } from "./context.js";

export const getUsage = op(async (
  ctx,
  options?: WorkspaceUsageOptions,
): Promise<WorkspaceUsage> => {
    const scopeUser = options?.path ? normalizePath(options.path) : "/";
    ctx.guardRead(scopeUser);
    const scopeInternal = ctx.toInternalPath(scopeUser);
    return ctx.withReadOnlyWorkspace(async (tx) => {
      const versionRootId = await ctx.getVersionRootId(tx);
      const versionId = await ctx.getCurrentVersionId(tx);
      const scopeLtree = pathToLtree(scopeInternal, ctx.workspaceId);
      const baseParams: SqlParam[] = [
        ctx.workspaceId,
        versionId,
        TOMBSTONE,
        scopeLtree,
        versionRootId,
      ];
      const exc = ctx.buildExcludeClause("e.path", baseParams.length + 1);
      const mnt = ctx.buildMountClause(
        "e.path",
        baseParams.length + 1 + exc.params.length,
      );
      const acrossSelectSql = options?.includeAcrossVersions
        ? `,
         versions_in_root AS (
           SELECT id FROM fs_versions
           WHERE workspace_id = $1 AND version_root_id = $5 AND deleted_at IS NULL
         ),
         across_visible_blobs AS (
           SELECT DISTINCT picked.blob_hash
           FROM versions_in_root vir
           CROSS JOIN LATERAL (
             SELECT DISTINCT ON (e.path)
               e.node_type, e.blob_hash
             FROM fs_entries e
             JOIN version_ancestors a
               ON a.workspace_id = e.workspace_id
              AND a.ancestor_id = e.version_id
             WHERE e.workspace_id = $1
                AND a.descendant_id = vir.id
                AND e.path <@ $4::ltree
                AND ${exc.sql}
                AND ${mnt.sql}
              ORDER BY e.path, a.depth ASC
            ) picked
           WHERE picked.node_type = 'file' AND picked.blob_hash IS NOT NULL
         )`
        : "";
      const acrossColumnsSql = options?.includeAcrossVersions
        ? `,
           (SELECT COUNT(*) FROM across_visible_blobs) AS across_referenced_blob_count,
           (SELECT COALESCE(SUM(b.size_bytes), 0)
            FROM across_visible_blobs av
            JOIN fs_blobs b ON b.workspace_id = $1 AND b.hash = av.blob_hash) AS across_referenced_blob_bytes`
        : `,
           NULL::bigint AS across_referenced_blob_count,
           NULL::bigint AS across_referenced_blob_bytes`;
      const r = await tx.query<UsageRow>(
        `WITH visible_raw AS (
           SELECT DISTINCT ON (e.path)
             e.node_type,
             e.size_bytes,
             e.blob_hash
           FROM fs_entries e
           JOIN version_ancestors a
             ON a.workspace_id = e.workspace_id
            AND a.ancestor_id = e.version_id
           WHERE e.workspace_id = $1
              AND a.descendant_id = $2
              AND e.path <@ $4::ltree
              AND ${exc.sql}
              AND ${mnt.sql}
            ORDER BY e.path, a.depth ASC
          ),
         visible AS (
           SELECT node_type, size_bytes, blob_hash
           FROM visible_raw
           WHERE node_type != $3
         ),
         referenced_blobs AS (
           SELECT DISTINCT blob_hash
           FROM visible
           WHERE node_type = 'file' AND blob_hash IS NOT NULL
          )${acrossSelectSql}
          SELECT
            (SELECT COUNT(*) FROM fs_versions WHERE workspace_id = $1 AND version_root_id = $5 AND deleted_at IS NULL) AS versions,
            (SELECT COUNT(*)
             FROM fs_entries e
             JOIN fs_versions v ON v.workspace_id = e.workspace_id AND v.id = e.version_id
             WHERE e.workspace_id = $1 AND v.version_root_id = $5) AS entry_rows,
            (SELECT COUNT(*)
             FROM fs_entries e
             JOIN fs_versions v ON v.workspace_id = e.workspace_id AND v.id = e.version_id
             WHERE e.workspace_id = $1 AND v.version_root_id = $5 AND e.node_type = $3) AS tombstone_rows,
            (SELECT COUNT(*) FROM fs_blobs WHERE workspace_id = $1) AS blob_count,
            (SELECT COALESCE(SUM(size_bytes), 0) FROM fs_blobs WHERE workspace_id = $1) AS stored_blob_bytes,
           (SELECT COALESCE(SUM(b.size_bytes), 0)
            FROM referenced_blobs rb
            JOIN fs_blobs b ON b.workspace_id = $1 AND b.hash = rb.blob_hash) AS referenced_blob_bytes,
           (SELECT COUNT(*) FROM visible) AS visible_nodes,
           (SELECT COUNT(*) FROM visible WHERE node_type = 'file') AS visible_files,
            (SELECT COUNT(*) FROM visible WHERE node_type = 'directory') AS visible_directories,
            (SELECT COUNT(*) FROM visible WHERE node_type = 'symlink') AS visible_symlinks,
            (SELECT COALESCE(SUM(size_bytes), 0) FROM visible) AS logical_bytes${acrossColumnsSql}`,
        [...baseParams, ...exc.params, ...mnt.params],
      );
      const row = r.rows[0]!;
      return {
        workspaceId: ctx.workspaceId,
        version: ctx.versionLabel,
        path: scopeUser,
        logicalBytes: Number(row.logical_bytes),
        referencedBlobBytes: Number(row.referenced_blob_bytes),
        storedBlobBytes: Number(row.stored_blob_bytes),
        blobCount: Number(row.blob_count),
        versions: Number(row.versions),
        entryRows: Number(row.entry_rows),
        tombstoneRows: Number(row.tombstone_rows),
        visibleNodes: Number(row.visible_nodes),
        visibleFiles: Number(row.visible_files),
        visibleDirectories: Number(row.visible_directories),
        visibleSymlinks: Number(row.visible_symlinks),
        ...(options?.includeAcrossVersions
          ? {
              acrossVersions: {
                referencedBlobBytes: Number(row.across_referenced_blob_bytes),
                referencedBlobCount: Number(row.across_referenced_blob_count),
              },
            }
          : {}),
        limits: {
          maxFiles: ctx.maxFiles,
          maxFileSize: ctx.maxFileSize,
          ...(ctx.maxWorkspaceBytes !== undefined ? { maxWorkspaceBytes: ctx.maxWorkspaceBytes } : {}),
        },
      };
    });
  });
