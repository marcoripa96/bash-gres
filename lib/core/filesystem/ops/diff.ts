import type { VersionDiffEntry } from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import { op } from "./context.js";
import { fetchDiff } from "./fetch-diff.js";

/**
 * Compare this version's visible tree to `other`'s visible tree at the same
 * workspace, and return the path-level differences.
 *
 * `before` is this version's entry; `after` is `other`'s. Reading "what
 * changes if current became `other`?" gives the natural interpretation.
 * Equality is over `node_type`, `blob_hash`, `mode`, and `symlink_target`;
 * `mtime`, `size_bytes`, and `created_at` are not part of the comparison.
 *
 * If `opts.path` is provided, the comparison is scoped to that user path
 * and its descendants. Tombstones in either version present as `null` for
 * that side.
 */
export const diff = op(async (
  ctx,
  other: string,
  opts?: { path?: string },
): Promise<VersionDiffEntry[]> => {
    if (other.length === 0) {
      throw new Error("diff: other must be a non-empty version label");
    }
    const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
    ctx.guardRead(scopeUser);
    const internalScope = ctx.toInternalPath(scopeUser);

    return ctx.withWorkspace(async (tx) => {
      const ourId = await ctx.getCurrentVersionId(tx);
      const theirId = await ctx.requireVersionIdByLabel(tx, other);
      const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
      const { entries } = await fetchDiff(ctx, tx, ourId, theirId, scopeLtree, null);
      return entries;
    });
  });
