import { op } from "./context.js";

interface LastWriteRow {
  last_write_at: Date | string;
}

/**
 * Return the timestamp of the last write to the current version. O(1) — reads
 * the denormalized `fs_versions.last_write_at` column maintained by every
 * write primitive.
 *
 * Semantics: "write" means any direct mutation of `fs_entries` under this
 * version_id (including tombstones, mode changes, mtime touches, and bulk
 * merge/cherry-pick/revert applies). A freshly forked version inherits its
 * parent's content by COW but reports its own creation time until the first
 * write — sibling branches do not affect it.
 *
 * Returns `null` only when the current version has somehow lost its row,
 * which shouldn't happen in normal use. Callers polling for changes should
 * compare against the last observed value rather than treating `null` as
 * "no change."
 */
export const getLastModified = op(async (ctx): Promise<Date | null> => {
  return ctx.withReadOnlyWorkspace(async (tx) => {
    const versionId = await ctx.getCurrentVersionId(tx);
    const r = await tx.query<LastWriteRow>(
      `SELECT last_write_at FROM fs_versions
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [ctx.workspaceId, versionId],
    );
    if (r.rows.length === 0) return null;
    return new Date(r.rows[0]!.last_write_at);
  });
});
