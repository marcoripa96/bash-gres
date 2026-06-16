import type { SqlClient, SqlParam, VersionDiffEntry } from "../../types.js";
import { ltreeToPath } from "../../path-encoding.js";
import {
  classifyDiffChange,
  decodeBlobContent,
  mapDiffSide,
} from "../internals/entry-shapes.js";
import type { DiffRow } from "../internals/rows.js";
import { op } from "./context.js";

const NULL_O_CONTENT_COLS = `
  NULL::text  AS o_content,
  NULL::bytea AS o_binary`;

const NULL_T_CONTENT_COLS = `
  NULL::text  AS t_content,
  NULL::bytea AS t_binary`;

const FULL_O_CONTENT_COLS = `
  ob.content     AS o_content,
  ob.binary_data AS o_binary`;

const FULL_T_CONTENT_COLS = `
  tb.content     AS t_content,
  tb.binary_data AS t_binary`;

/**
 * Run the actual diff SQL: two visible-entry CTEs, FULL OUTER JOIN by path,
 * filter out equal rows. Returns rows already mapped to `VersionDiffEntry`
 * plus the encoded-ltree path of the last row, suitable as the next
 * keyset-pagination cursor.
 *
 * When `includeContent` is true, LEFT JOINs `fs_blobs` on both sides and
 * populates `beforeContent` / `afterContent` on each entry. The join is
 * restricted to changed paths (already filtered by the equal-row WHERE
 * clause) so identical files never touch the blob table.
 */
export const fetchDiff = op(async (
  ctx,
  tx: SqlClient,
  ourId: number,
  theirId: number,
  scopeLtree: string,
  page: { cursor: string | null; limit: number } | null,
  includeContent: boolean = false,
): Promise<{ entries: VersionDiffEntry[]; lastLtree: string | null }> => {
    const params: SqlParam[] = [ctx.workspaceId, ourId, theirId, scopeLtree];
    let cursorClause = "";
    let limitClause = "";
    if (page) {
      if (page.cursor !== null) {
        params.push(page.cursor);
        cursorClause = `AND path > $${params.length}::ltree`;
      }
      params.push(page.limit);
      limitClause = `LIMIT $${params.length}`;
    }
    const exc = ctx.buildExcludeClause("e.path", params.length + 1);
    params.push(...exc.params);
    const mnt = ctx.buildMountClause("e.path", params.length + 1);
    params.push(...mnt.params);

    const oContentCols = includeContent ? FULL_O_CONTENT_COLS : NULL_O_CONTENT_COLS;
    const tContentCols = includeContent ? FULL_T_CONTENT_COLS : NULL_T_CONTENT_COLS;
    const oBlobJoin = includeContent
      ? `LEFT JOIN fs_blobs ob ON ob.workspace_id = $1 AND ob.hash = ours.blob_hash`
      : "";
    const tBlobJoin = includeContent
      ? `LEFT JOIN fs_blobs tb ON tb.workspace_id = $1 AND tb.hash = theirs.blob_hash`
      : "";

    const sql = `
      WITH ours_raw AS (
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
          e.mode,
          e.size_bytes,
          e.mtime
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
      SELECT
        path::text AS path,
        ours.node_type AS o_type,
        ours.blob_hash AS o_hash,
        ours.symlink_target AS o_link,
        ours.mode AS o_mode,
        ours.size_bytes AS o_size,
        ours.mtime AS o_mtime,
        ${oContentCols},
        theirs.node_type AS t_type,
        theirs.blob_hash AS t_hash,
        theirs.symlink_target AS t_link,
        theirs.mode AS t_mode,
        theirs.size_bytes AS t_size,
        theirs.mtime AS t_mtime,
        ${tContentCols}
      FROM ours
      FULL OUTER JOIN theirs USING (path)
      ${oBlobJoin}
      ${tBlobJoin}
      WHERE (
        ours.node_type IS NULL
        OR theirs.node_type IS NULL
        OR ours.node_type != theirs.node_type
        OR ours.mode != theirs.mode
        OR ours.symlink_target IS DISTINCT FROM theirs.symlink_target
        OR ours.blob_hash IS DISTINCT FROM theirs.blob_hash
      )
      ${cursorClause}
      ORDER BY path
      ${limitClause}
    `;

    const result = await tx.query<DiffRow>(sql, params);
    const entries: VersionDiffEntry[] = [];
    for (const row of result.rows) {
      const before = mapDiffSide(
        row.o_type,
        row.o_hash,
        row.o_link,
        row.o_mode,
        row.o_size,
        row.o_mtime,
      );
      const after = mapDiffSide(
        row.t_type,
        row.t_hash,
        row.t_link,
        row.t_mode,
        row.t_size,
        row.t_mtime,
      );
      const entry: VersionDiffEntry = {
        path: ctx.toUserPath(ltreeToPath(row.path)),
        change: classifyDiffChange(before, after),
        before,
        after,
      };
      if (includeContent) {
        entry.beforeContent = decodeBlobContent(before, row.o_content, row.o_binary);
        entry.afterContent = decodeBlobContent(after, row.t_content, row.t_binary);
      }
      entries.push(entry);
    }
    const lastLtree =
      result.rows.length > 0 ? result.rows[result.rows.length - 1]!.path : null;
    return { entries, lastLtree };
  });
