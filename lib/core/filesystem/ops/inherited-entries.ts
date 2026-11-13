import type { SqlClient } from "../../types.js";
import type { FilesystemOpsContext } from "./context.js";

/**
 * Shared steps of the ops that stop versions reading through their ancestors
 * (`detach`, `materialize`, `sweepHistory`, `compactHistory`).
 */

/**
 * Lock `versionId` and every descendant of it (its subtree in the ancestor
 * closure, itself included), row locks then advisory locks, both in id
 * order like the other graph mutators. Returns the subtree ids.
 */
export async function lockSubtree<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<number[]> {
  const sub = await tx.query<{ id: number | string }>(
    `SELECT descendant_id AS id
     FROM version_ancestors
     WHERE workspace_id = $1 AND ancestor_id = $2
     ORDER BY descendant_id`,
    [ctx.workspaceId, versionId],
  );
  const subtreeIds = sub.rows.map((r) => Number(r.id));
  if (subtreeIds.length > 0) {
    await tx.query(
      `SELECT id FROM fs_versions
       WHERE workspace_id = $1 AND id = ANY($2::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [ctx.workspaceId, subtreeIds],
    );
    await ctx.lockVersions(tx, subtreeIds);
  }
  return subtreeIds;
}

/**
 * Copy into each of `versionIds` the entry it currently inherits at every
 * path it does not own: the nearest ancestor's row (`ROW_NUMBER() ...
 * ORDER BY depth`), skipping rows the version owns (tombstones included,
 * which stay where they are) and inherited tombstones. One statement for
 * the whole batch. What each version shows does not change.
 *
 * `bumpLastWrite` stamps `last_write_at` on the unfrozen ones (the
 * historical behaviour of `detach` and `sweepHistory`); frozen versions are
 * never bumped, since their content does not change. Returns the number of
 * rows copied.
 */
export async function copyInheritedEntries<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionIds: number[],
  opts: { bumpLastWrite: boolean },
): Promise<number> {
  if (versionIds.length === 0) return 0;
  const bump = opts.bumpLastWrite
    ? `version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = ANY($2::bigint[])
           AND frozen_at IS NULL
         RETURNING 1
       ),`
    : "";
  const r = await tx.query<{ count: number | string }>(
    `WITH ${bump}
     ins AS (
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
    [ctx.workspaceId, versionIds],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/**
 * Delete the closure rows from a subtree to ancestors outside it. Rows
 * internal to the subtree (each version's self row included) stay.
 */
export async function cutClosureOutside<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  subtreeIds: number[],
): Promise<void> {
  if (subtreeIds.length === 0) return;
  await tx.query(
    `DELETE FROM version_ancestors
     WHERE workspace_id = $1
       AND descendant_id = ANY($2::bigint[])
       AND NOT (ancestor_id = ANY($2::bigint[]))`,
    [ctx.workspaceId, subtreeIds],
  );
}
