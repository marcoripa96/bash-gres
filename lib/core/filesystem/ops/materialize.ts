import type { SqlClient } from "../../types.js";
import { op, type FilesystemOpsContext } from "./context.js";
import {
  copyInheritedEntries,
  cutClosureOutside,
  lockSubtree,
} from "./inherited-entries.js";

/**
 * Copy into the current version every entry it inherits from its ancestors,
 * then cut its ancestor-closure rows, so it stops reading through (and
 * paying for) its ancestor chain. Unlike `detach()`, it keeps
 * `parent_version_id` and the version's tombstones: `listHistory`,
 * `versionDiff` and merge bases still pass through it, and a fork of it
 * costs two closure rows however long the history behind it.
 *
 * What the version and its descendants show does not change. Works on a
 * frozen version (no content changes, no `last_write_at` bump). Idempotent.
 * Cost: O(visible entries) + O(versions in the version's subtree).
 */
export const materialize = op(async (ctx): Promise<void> => {
  await ctx.withWorkspace(async (tx) => {
    await materializeVersion(ctx, tx, await ctx.getCurrentVersionId(tx));
  });
});

export async function materializeVersion<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<void> {
  const subtreeIds = await lockSubtree(ctx, tx, versionId);
  await copyInheritedEntries(ctx, tx, [versionId], { bumpLastWrite: false });
  await cutClosureOutside(ctx, tx, subtreeIds);
}
