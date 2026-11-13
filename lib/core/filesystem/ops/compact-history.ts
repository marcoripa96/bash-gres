import type { CompactHistoryResult } from "../../types.js";
import { op } from "./context.js";
import { copyInheritedEntries } from "./inherited-entries.js";

interface VersionRow {
  id: number | string;
  settled: boolean;
}

interface CountRow {
  count: number | string;
}

/**
 * Shrink the ancestor closure of this version root without losing history.
 * Every settled version is materialized, and each version's closure is
 * trimmed at its nearest settled ancestor. A version is settled when it and
 * every ancestor it reads through are frozen or deleted-but-retained: a
 * frozen version under a live, unfrozen ancestor still shows that
 * ancestor's later writes (the live overlay), so it is left as it is. Nothing is removed: version ids, parent links, merge
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
    await tx.query(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND version_root_id = $2
       ORDER BY id
       FOR UPDATE`,
      [ctx.workspaceId, versionRootId],
    );
    // Settled: no version in its closure (itself included) is live and
    // unfrozen, so nothing it reads through can still be written by label.
    const rows = await tx.query<VersionRow>(
      `SELECT v.id,
              NOT EXISTS (
                SELECT 1
                FROM version_ancestors a
                JOIN fs_versions anc
                  ON anc.workspace_id = a.workspace_id AND anc.id = a.ancestor_id
                WHERE a.workspace_id = v.workspace_id
                  AND a.descendant_id = v.id
                  AND anc.deleted_at IS NULL
                  AND anc.frozen_at IS NULL
              ) AS settled
       FROM fs_versions v
       WHERE v.workspace_id = $1 AND v.version_root_id = $2
       ORDER BY v.id`,
      [ctx.workspaceId, versionRootId],
    );
    const allIds = rows.rows.map((r) => Number(r.id));
    const settled = rows.rows.filter((r) => r.settled).map((r) => Number(r.id));
    if (settled.length === 0) {
      return { materializedVersions: 0, copiedEntries: 0, removedAncestorRows: 0 };
    }
    await ctx.lockVersions(tx, allIds);

    const copiedEntries = await copyInheritedEntries(ctx, tx, settled, {
      bumpLastWrite: false,
    });

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
      copiedEntries,
      removedAncestorRows: Number(trimmed.rows[0]?.count ?? 0),
    };
  });
});
