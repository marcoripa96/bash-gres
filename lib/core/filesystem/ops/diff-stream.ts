import type { VersionDiffEntry, VersionDiffStreamOptions } from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import {
  DIFF_DEFAULT_BATCH_SIZE,
  DIFF_MAX_BATCH_SIZE,
} from "../internals/constants.js";
import { op } from "./context.js";
import { fetchDiff } from "./fetch-diff.js";

/**
 * Streaming diff with keyset pagination by encoded ltree path. Each batch is
 * fetched in its own short transaction; the stream is not snapshot-isolated
 * across the whole iteration. Use `diff()` for an in-memory snapshot.
 */
export const diffStream = op(async function* (
  ctx,
  other: string,
  opts?: VersionDiffStreamOptions,
): AsyncIterable<VersionDiffEntry> {
    if (other.length === 0) {
      throw new Error("diffStream: other must be a non-empty version label");
    }
    const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
    ctx.guardRead(scopeUser);
    const internalScope = ctx.toInternalPath(scopeUser);
    const requested = opts?.batchSize ?? DIFF_DEFAULT_BATCH_SIZE;
    const batchSize = Math.max(1, Math.min(requested, DIFF_MAX_BATCH_SIZE));

    const includeContent = opts?.includeContent ?? false;
    let cursor: string | null = null;
    while (true) {
      const { entries, lastLtree } = await ctx.withReadOnlyWorkspace(async (tx) => {
        const ourId = await ctx.getCurrentVersionId(tx);
        const theirId = await ctx.requireVersionIdByLabel(tx, other);
        const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
        return fetchDiff(
          ctx,
          tx,
          ourId,
          theirId,
          scopeLtree,
          { cursor, limit: batchSize },
          includeContent,
        );
      });
      for (const entry of entries) yield entry;
      if (entries.length < batchSize) return;
      cursor = lastLtree;
    }
  });
