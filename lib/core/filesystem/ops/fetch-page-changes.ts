import type { SqlClient, SqlParam, VersionDiffEntry } from "../../types.js";
import { ltreeToPath } from "../../path-encoding.js";
import { mapDiffSide } from "../internals/entry-shapes.js";
import { op, type FilesystemOpsContext } from "./context.js";

interface BatchRow {
  owner_v: number | string;
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

const NULL_O_SHAPE = `
  NULL::bytea       AS o_hash,
  NULL::text        AS o_link,
  NULL::int         AS o_mode,
  NULL::bigint      AS o_size,
  NULL::timestamptz AS o_mtime`;

const NULL_P_SHAPE = `
  NULL::bytea       AS p_hash,
  NULL::text        AS p_link,
  NULL::int         AS p_mode,
  NULL::bigint      AS p_size,
  NULL::timestamptz AS p_mtime`;

const FULL_O_SHAPE = `
  (CASE WHEN w.o_node_type = 'tombstone' THEN NULL ELSE w.o_blob_hash      END) AS o_hash,
  (CASE WHEN w.o_node_type = 'tombstone' THEN NULL ELSE w.o_symlink_target END) AS o_link,
  (CASE WHEN w.o_node_type = 'tombstone' THEN NULL ELSE w.o_mode           END) AS o_mode,
  (CASE WHEN w.o_node_type = 'tombstone' THEN NULL ELSE w.o_size_bytes     END) AS o_size,
  (CASE WHEN w.o_node_type = 'tombstone' THEN NULL ELSE w.o_mtime          END) AS o_mtime`;

const FULL_P_SHAPE = `
  pv.p_blob_hash      AS p_hash,
  pv.p_symlink_target AS p_link,
  pv.p_mode           AS p_mode,
  pv.p_size_bytes     AS p_size,
  pv.p_mtime          AS p_mtime`;

/**
 * Single batched query that computes per-version changes for an entire
 * `listHistory` page. Replaces the N round trips one would make by calling
 * `fetchVersionChanges` per entry. Uses the COW shortcut on the "after"
 * side and resolves parent visibility per (owner_version, path).
 *
 * Root entries (parent_version_id IS NULL) flow through the same query —
 * the closure-table join naturally yields no parent rows for them, so all
 * their writes surface as `added`.
 *
 * Returns a map keyed by `versionId` for easy zip-up with the page rows.
 * Versions in `versionIds` with no changes get an empty array; missing
 * versions are omitted.
 */
export const fetchPageChanges = op(async <TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionIds: number[],
  scopeLtree: string,
  pathsOnly: boolean,
): Promise<Map<number, VersionDiffEntry[]>> => {
  const grouped = new Map<number, VersionDiffEntry[]>();
  for (const id of versionIds) grouped.set(id, []);
  if (versionIds.length === 0) return grouped;

  const params: SqlParam[] = [ctx.workspaceId, versionIds, scopeLtree];
  const exc = ctx.buildExcludeClause("e.path", params.length + 1);
  params.push(...exc.params);
  const oShape = pathsOnly ? NULL_O_SHAPE : FULL_O_SHAPE;
  const pShape = pathsOnly ? NULL_P_SHAPE : FULL_P_SHAPE;

  const sql = `
    WITH page_versions AS (
      SELECT v.id AS owner_v, v.parent_version_id
      FROM fs_versions v
      WHERE v.workspace_id = $1 AND v.id = ANY($2::bigint[])
    ),
    v_writes AS (
      SELECT
        e.version_id            AS owner_v,
        e.path,
        e.node_type             AS o_node_type,
        e.blob_hash             AS o_blob_hash,
        e.symlink_target        AS o_symlink_target,
        e.mode                  AS o_mode,
        e.size_bytes            AS o_size_bytes,
        e.mtime                 AS o_mtime
      FROM fs_entries e
      WHERE e.workspace_id = $1
        AND e.version_id = ANY($2::bigint[])
        AND e.path <@ $3::ltree
        AND ${exc.sql}
    ),
    -- For each (owner_v, path) in v_writes whose owner has a parent,
    -- find the deepest-ancestor entry of the parent that covers that path.
    parent_visible_raw AS (
      SELECT DISTINCT ON (w.owner_v, w.path)
        w.owner_v          AS owner_v,
        w.path             AS path,
        e.node_type        AS p_node_type,
        e.blob_hash        AS p_blob_hash,
        e.symlink_target   AS p_symlink_target,
        e.mode             AS p_mode,
        e.size_bytes       AS p_size_bytes,
        e.mtime            AS p_mtime,
        a.depth            AS depth
      FROM v_writes w
      JOIN page_versions pv ON pv.owner_v = w.owner_v
                            AND pv.parent_version_id IS NOT NULL
      JOIN version_ancestors a
        ON a.workspace_id = $1 AND a.descendant_id = pv.parent_version_id
      JOIN fs_entries e
        ON e.workspace_id = $1
       AND e.version_id   = a.ancestor_id
       AND e.path         = w.path
      ORDER BY w.owner_v, w.path, a.depth ASC
    ),
    parent_visible AS (
      SELECT owner_v, path,
             p_node_type, p_blob_hash, p_symlink_target,
             p_mode, p_size_bytes, p_mtime
      FROM parent_visible_raw
      WHERE p_node_type != 'tombstone'
    )
    SELECT
      w.owner_v::bigint AS owner_v,
      w.path::text      AS path,
      (CASE WHEN w.o_node_type = 'tombstone' THEN NULL ELSE w.o_node_type END) AS o_type,
      ${oShape},
      pv.p_node_type AS p_type,
      ${pShape}
    FROM v_writes w
    LEFT JOIN parent_visible pv
      ON pv.owner_v = w.owner_v AND pv.path = w.path
    WHERE (w.o_node_type != 'tombstone' OR pv.p_node_type IS NOT NULL)
      AND (
        w.o_node_type = 'tombstone'
        OR pv.p_node_type IS NULL
        OR w.o_node_type != pv.p_node_type
        OR w.o_mode != pv.p_mode
        OR w.o_symlink_target IS DISTINCT FROM pv.p_symlink_target
        OR w.o_blob_hash IS DISTINCT FROM pv.p_blob_hash
      )
    ORDER BY w.owner_v, w.path
  `;

  const result = await tx.query<BatchRow>(sql, params);
  for (const row of result.rows) {
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
    const entry: VersionDiffEntry = {
      path: ctx.toUserPath(ltreeToPath(row.path)),
      change,
      before,
      after,
    };
    const ownerV = Number(row.owner_v);
    grouped.get(ownerV)?.push(entry);
  }
  return grouped;
});
