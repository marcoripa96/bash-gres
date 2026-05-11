import type { SqlClient, SqlParam, VersionDiffEntry } from "../../types.js";
import { ltreeToPath } from "../../path-encoding.js";
import { mapDiffSide } from "../internals/entry-shapes.js";
import { op, type FilesystemOpsContext } from "./context.js";

interface ChangeRow {
  path: string;
  o_type: string | null;
  o_hash: Uint8Array | null;
  o_link: string | null;
  o_mode: number | null;
  o_size: number | string | null;
  o_mtime: Date | string | null;
  p_type: string | null;
  p_hash: Uint8Array | null;
  p_link: string | null;
  p_mode: number | null;
  p_size: number | string | null;
  p_mtime: Date | string | null;
}

const NULL_P_SHAPE_COLS = `
  NULL::bytea       AS p_hash,
  NULL::text        AS p_link,
  NULL::int         AS p_mode,
  NULL::bigint      AS p_size,
  NULL::timestamptz AS p_mtime`;

const NULL_O_SHAPE_COLS = `
  NULL::bytea       AS o_hash,
  NULL::text        AS o_link,
  NULL::int         AS o_mode,
  NULL::bigint      AS o_size,
  NULL::timestamptz AS o_mtime`;

const FULL_O_SHAPE_COLS = `
  (CASE WHEN w.node_type = 'tombstone' THEN NULL ELSE w.blob_hash      END) AS o_hash,
  (CASE WHEN w.node_type = 'tombstone' THEN NULL ELSE w.symlink_target END) AS o_link,
  (CASE WHEN w.node_type = 'tombstone' THEN NULL ELSE w.mode           END) AS o_mode,
  (CASE WHEN w.node_type = 'tombstone' THEN NULL ELSE w.size_bytes     END) AS o_size,
  (CASE WHEN w.node_type = 'tombstone' THEN NULL ELSE w.mtime          END) AS o_mtime`;

const FULL_P_SHAPE_COLS = `
  pv.blob_hash      AS p_hash,
  pv.symlink_target AS p_link,
  pv.mode           AS p_mode,
  pv.size_bytes     AS p_size,
  pv.mtime          AS p_mtime`;

/**
 * COW-shortcut diff for a single version against its parent (or against an
 * empty tree when `parentVersionId === null`). Reads the "after" side
 * directly from `fs_entries WHERE version_id = V` — under COW the rows
 * physically written at V are exactly what changed at V — and resolves
 * parent visibility for that subset of paths only. Skips the full
 * visible-tree CTE that `fetchDiff` runs on both sides.
 *
 * Supports keyset pagination by encoded ltree path (`page.cursor`) and an
 * optional `pathsOnly` projection that omits shape columns for cheaper
 * scans.
 */
export const fetchVersionChanges = op(async <TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
  parentVersionId: number | null,
  scopeLtree: string,
  page: { cursor: string | null; limit: number } | null,
  pathsOnly: boolean,
): Promise<{ entries: VersionDiffEntry[]; lastLtree: string | null }> => {
  const params: SqlParam[] = [ctx.workspaceId, versionId, scopeLtree];
  let parentClause = "";
  if (parentVersionId !== null) {
    params.push(parentVersionId);
    parentClause = `AND a.descendant_id = $${params.length}`;
  }
  const exc = ctx.buildExcludeClause("w.path", params.length + 1);
  params.push(...exc.params);
  let cursorClause = "";
  let limitClause = "";
  if (page) {
    if (page.cursor !== null) {
      params.push(page.cursor);
      cursorClause = `AND w.path > $${params.length}::ltree`;
    }
    params.push(page.limit);
    limitClause = `LIMIT $${params.length}`;
  }

  const oShapeCols = pathsOnly ? NULL_O_SHAPE_COLS : FULL_O_SHAPE_COLS;
  const pShapeCols = pathsOnly ? NULL_P_SHAPE_COLS : FULL_P_SHAPE_COLS;

  const sql = parentVersionId === null
    ? `SELECT
         w.path::text AS path,
         w.node_type  AS o_type,
         ${oShapeCols},
         NULL::text   AS p_type,
         ${NULL_P_SHAPE_COLS}
       FROM fs_entries w
       WHERE w.workspace_id = $1
         AND w.version_id  = $2
         AND w.path       <@ $3::ltree
         AND w.node_type  != 'tombstone'
         AND ${exc.sql}
         ${cursorClause}
       ORDER BY w.path
       ${limitClause}`
    : `WITH v_writes AS (
         SELECT w.path, w.node_type, w.blob_hash, w.symlink_target,
                w.mode, w.size_bytes, w.mtime
         FROM fs_entries w
         WHERE w.workspace_id = $1
           AND w.version_id  = $2
           AND w.path       <@ $3::ltree
           AND ${exc.sql}
       ),
       parent_visible_raw AS (
         SELECT DISTINCT ON (e.path)
           e.path, e.node_type, e.blob_hash, e.symlink_target,
           e.mode, e.size_bytes, e.mtime
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           ${parentClause}
           AND e.path IN (SELECT path FROM v_writes)
         ORDER BY e.path, a.depth ASC
       ),
       parent_visible AS (
         SELECT path AS pv_path, node_type, blob_hash, symlink_target,
                mode, size_bytes, mtime
         FROM parent_visible_raw
         WHERE node_type != 'tombstone'
       )
       SELECT
         w.path::text AS path,
         (CASE WHEN w.node_type = 'tombstone' THEN NULL ELSE w.node_type END) AS o_type,
         ${oShapeCols},
         pv.node_type AS p_type,
         ${pShapeCols}
       FROM v_writes w
       LEFT JOIN parent_visible pv ON pv.pv_path = w.path
       WHERE (w.node_type != 'tombstone' OR pv.node_type IS NOT NULL)
         AND (
           w.node_type = 'tombstone'
           OR pv.node_type IS NULL
           OR w.node_type != pv.node_type
           OR w.mode != pv.mode
           OR w.symlink_target IS DISTINCT FROM pv.symlink_target
           OR w.blob_hash IS DISTINCT FROM pv.blob_hash
         )
         ${cursorClause}
       ORDER BY w.path
       ${limitClause}`;

  const result = await tx.query<ChangeRow>(sql, params);
  const entries: VersionDiffEntry[] = result.rows.map((row) => {
    const before = pathsOnly
      ? null
      : mapDiffSide(row.p_type, row.p_hash, row.p_link, row.p_mode, row.p_size,
          row.p_mtime === null ? null : new Date(row.p_mtime));
    const after = pathsOnly
      ? null
      : mapDiffSide(row.o_type, row.o_hash, row.o_link, row.o_mode, row.o_size,
          row.o_mtime === null ? null : new Date(row.o_mtime));
    const change: VersionDiffEntry["change"] =
      row.p_type === null
        ? "added"
        : row.o_type === null
          ? "removed"
          : row.o_type !== row.p_type
            ? "type-changed"
            : "modified";
    return {
      path: ctx.toUserPath(ltreeToPath(row.path)),
      change,
      before,
      after,
    };
  });
  const lastLtree =
    result.rows.length > 0 ? result.rows[result.rows.length - 1]!.path : null;
  return { entries, lastLtree };
});
