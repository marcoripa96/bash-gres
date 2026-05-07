import { op } from "./context.js";

/**
 * Detach the current version from its ancestor chain so it stops depending
 * on any former ancestor for paths it can currently see.
 *
 * Visible contents of the current version and of every descendant are
 * preserved byte-for-byte. After commit, `parent_version_id` of the current
 * version is `NULL`, closure rows from the current subtree to versions
 * outside the subtree are gone, and former ancestors can be deleted (subject
 * to their own descendant checks) without changing what the current version
 * shows.
 *
 * Steps inside one transaction:
 *   1. Resolve the current version `V` and the set of all descendants of `V`
 *      (the "subtree", inclusive of `V`).
 *   2. Lock subtree version rows in `fs_versions` (FOR UPDATE) and acquire
 *      advisory mutation locks for the same IDs in deterministic order.
 *   3. Materialize visible non-tombstone entries from `V`'s former ancestors
 *      into `V`'s own `fs_entries` rows. Existing rows on `V` win
 *      (`ON CONFLICT DO NOTHING`).
 *   4. Set `V.parent_version_id = NULL`.
 *   5. Delete closure rows from any subtree descendant to ancestors outside
 *      the subtree. Closure rows internal to the subtree are kept.
 *   6. Drop tombstones at `V`. Now that `V` has no ancestors and no
 *      descendant inherits from those ancestors via `V`, tombstones at `V`
 *      cannot hide anything.
 *
 * Idempotent: detaching an already-root version is a no-op modulo dropping
 * any pre-existing tombstones at `V` (which serve no purpose on a root).
 *
 * Cost: O(visible paths in `V`) + O(versions in `V`'s subtree). Honors
 * `statementTimeoutMs`; large subtrees should raise the timeout.
 */
export const detach = op(async (ctx): Promise<void> => {
  return ctx.withWorkspace(async (tx) => {
    const versionId = await ctx.getCurrentVersionId(tx);

    // 1. Subtree IDs (including V itself, via the self-row in version_ancestors).
    const sub = await tx.query<{ id: number }>(
      `SELECT descendant_id AS id
       FROM version_ancestors
       WHERE workspace_id = $1 AND ancestor_id = $2
       ORDER BY descendant_id`,
      [ctx.workspaceId, versionId],
    );
    const subtreeIds = sub.rows.map((r) => Number(r.id));

    // 2. Lock fs_versions rows, then acquire advisory locks. Both in sorted
    //    order to match other graph mutators.
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

    // 3. Materialize V's visible non-tombstone entries into V's own rows.
    //    The DISTINCT ON returns the closest ancestor row per path; tombstones
    //    at depth 0+ correctly mask ancestor files (the outer
    //    `node_type <> 'tombstone'` filter then drops them). Rows already
    //    owned by V (`src.version_id = V`) are skipped so we never INSERT a
    //    duplicate of V's own row.
    await tx.query(
      `INSERT INTO fs_entries (
         workspace_id, version_id, path, blob_hash, node_type,
         symlink_target, mode, size_bytes, mtime, created_at
       )
       SELECT
         $1, $2,
         src.path, src.blob_hash, src.node_type,
         src.symlink_target, src.mode, src.size_bytes, src.mtime, now()
       FROM (
         SELECT DISTINCT ON (e.path)
                e.path, e.blob_hash, e.node_type, e.symlink_target,
                e.mode, e.size_bytes, e.mtime, e.version_id
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
         ORDER BY e.path, a.depth ASC
       ) src
       WHERE src.version_id <> $2
         AND src.node_type <> 'tombstone'
       ON CONFLICT (workspace_id, version_id, path) DO NOTHING`,
      [ctx.workspaceId, versionId],
    );

    // 4. Detach V from its parent in the version graph.
    await tx.query(
      `UPDATE fs_versions
       SET parent_version_id = NULL
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, versionId],
    );

    // 5. Remove closure rows from anywhere in the subtree to ancestors that
    //    fall outside it. Within-subtree rows (including each version's self
    //    row at depth 0) are preserved.
    if (subtreeIds.length > 0) {
      await tx.query(
        `DELETE FROM version_ancestors
         WHERE workspace_id = $1
           AND descendant_id = ANY($2::bigint[])
           AND NOT (ancestor_id = ANY($2::bigint[]))`,
        [ctx.workspaceId, subtreeIds],
      );
    }

    // 6. Tombstones on V no longer mask anything: V has no ancestors, and
    //    descendants no longer reach V's former ancestors through V.
    await tx.query(
      `DELETE FROM fs_entries
       WHERE workspace_id = $1
         AND version_id = $2
         AND node_type = 'tombstone'`,
      [ctx.workspaceId, versionId],
    );
  });
});
