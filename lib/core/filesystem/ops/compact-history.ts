import type { CompactHistoryResult } from "../../types.js";
import { op } from "./context.js";

interface VersionRow {
  id: number | string;
  deleted_at: Date | string | null;
  frozen_at: Date | string | null;
}

interface CountRow {
  count: number | string;
}

/**
 * Shrink the ancestor closure of this version root without losing history.
 * Every version that can no longer change (frozen, or deleted but retained)
 * is materialized, and each version's closure is trimmed at its nearest
 * such ancestor. Nothing is removed: version ids, parent links, merge
 * records and `listHistory` stay as they are, and every version shows what
 * it showed before.
 *
 * Use it once on roots built before `promoteTo(..., { materialize: true })`
 * to turn a quadratic closure into a linear one. Unlike `sweepHistory()`,
 * it keeps every version readable by id.
 */
export const compactHistory = op(async (ctx): Promise<CompactHistoryResult> => {
  return ctx.withWorkspace(async (tx) => {
    const versionRootId = await ctx.getVersionRootId(tx);
    const rows = await tx.query<VersionRow>(
      `SELECT id, deleted_at, frozen_at
       FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2
       ORDER BY id
       FOR UPDATE`,
      [ctx.workspaceId, versionRootId],
    );
    const allIds = rows.rows.map((r) => Number(r.id));
    const settled = rows.rows
      .filter((r) => r.deleted_at !== null || r.frozen_at !== null)
      .map((r) => Number(r.id));
    if (settled.length === 0) {
      return { materializedVersions: 0, copiedEntries: 0, removedAncestorRows: 0 };
    }
    await ctx.lockVersions(tx, allIds);

    // One statement for every settled version: the nearest ancestor row per
    // (version, path), skipping rows the version owns and tombstones.
    const copied = await tx.query<CountRow>(
      `WITH ins AS (
         INSERT INTO fs_entries (
           workspace_id, version_id, path, blob_hash, node_type,
           symlink_target, mode, size_bytes, mtime, created_at
         )
         SELECT
           $1, src.descendant_id,
           src.path, src.blob_hash, src.node_type,
           src.symlink_target, src.mode, src.size_bytes, src.mtime, now()
         FROM (
           SELECT
             a.descendant_id,
             e.path, e.blob_hash, e.node_type, e.symlink_target,
             e.mode, e.size_bytes, e.mtime, e.version_id AS source_version_id,
             ROW_NUMBER() OVER (
               PARTITION BY a.descendant_id, e.path
               ORDER BY a.depth ASC
             ) AS rn
           FROM version_ancestors a
           JOIN fs_entries e
             ON e.workspace_id = a.workspace_id
            AND e.version_id = a.ancestor_id
           WHERE a.workspace_id = $1
             AND a.descendant_id = ANY($2::bigint[])
         ) src
         WHERE src.rn = 1
           AND src.source_version_id <> src.descendant_id
           AND src.node_type <> 'tombstone'
         ON CONFLICT (workspace_id, version_id, path) DO NOTHING
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM ins`,
      [ctx.workspaceId, settled],
    );

    // Each version keeps its closure down to its nearest settled ancestor
    // (itself, at depth 0, when it is settled): that ancestor now holds
    // everything the rows beyond it supplied.
    const trimmed = await tx.query<CountRow>(
      `WITH cut AS (
         SELECT a.descendant_id, MIN(a.depth) AS cutoff
         FROM version_ancestors a
         WHERE a.workspace_id = $1
           AND a.descendant_id = ANY($2::bigint[])
           AND a.ancestor_id = ANY($3::bigint[])
         GROUP BY a.descendant_id
       ),
       del AS (
         DELETE FROM version_ancestors x
         USING cut
         WHERE x.workspace_id = $1
           AND x.descendant_id = cut.descendant_id
           AND x.depth > cut.cutoff
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM del`,
      [ctx.workspaceId, allIds, settled],
    );

    return {
      materializedVersions: settled.length,
      copiedEntries: Number(copied.rows[0]?.count ?? 0),
      removedAncestorRows: Number(trimmed.rows[0]?.count ?? 0),
    };
  });
});
