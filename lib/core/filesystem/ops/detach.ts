import { op } from "./context.js";
import {
  copyInheritedEntries,
  cutClosureOutside,
  lockSubtree,
} from "./inherited-entries.js";

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

    // 1-2. Lock V's subtree (V included through its self row).
    const subtreeIds = await lockSubtree(ctx, tx, versionId);

    // 3. Materialize V's visible entries into V's own rows.
    await copyInheritedEntries(ctx, tx, [versionId], { bumpLastWrite: true });

    // 4. Detach V from its parent in the version graph.
    await tx.query(
      `UPDATE fs_versions
       SET parent_version_id = NULL
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, versionId],
    );

    // 5. Remove closure rows from the subtree to ancestors outside it.
    await cutClosureOutside(ctx, tx, subtreeIds);

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
