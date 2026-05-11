import type { VersionDiffEntry, VersionDiffStreamOptions } from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import {
  DIFF_DEFAULT_BATCH_SIZE,
  DIFF_MAX_BATCH_SIZE,
} from "../internals/constants.js";
import { op } from "./context.js";
import { fetchVersionChanges } from "./fetch-version-changes.js";
import { resolveParentVersionId } from "./version-diff.js";

/**
 * Streaming variant of `versionDiff`. Pages by encoded ltree path with
 * keyset pagination. Each batch runs in its own short transaction; not
 * snapshot-isolated across the whole iteration.
 */
export const versionDiffStream = op(async function* (
  ctx,
  versionId: number,
  opts?: VersionDiffStreamOptions,
): AsyncIterable<VersionDiffEntry> {
  if (!Number.isInteger(versionId) || versionId <= 0) {
    throw new Error("versionDiffStream: versionId must be a positive integer");
  }
  const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
  ctx.guardRead(scopeUser);
  const internalScope = ctx.toInternalPath(scopeUser);
  const requested = opts?.batchSize ?? DIFF_DEFAULT_BATCH_SIZE;
  const batchSize = Math.max(1, Math.min(requested, DIFF_MAX_BATCH_SIZE));

  const parentVersionId = await ctx.withReadOnlyWorkspace((tx) =>
    resolveParentVersionId(ctx, tx, versionId),
  );

  let cursor: string | null = null;
  while (true) {
    const { entries, lastLtree } = await ctx.withReadOnlyWorkspace(async (tx) => {
      const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
      return fetchVersionChanges(ctx, tx, versionId, parentVersionId, scopeLtree, {
        cursor,
        limit: batchSize,
      }, false);
    });
    for (const entry of entries) yield entry;
    if (entries.length < batchSize) return;
    cursor = lastLtree;
  }
});
