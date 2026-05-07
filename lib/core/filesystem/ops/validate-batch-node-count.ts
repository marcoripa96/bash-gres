import type { SqlClient } from "../../types.js";
import type { InternalEntryShape } from "../internals/entry-shapes.js";
import { op } from "./context.js";

/**
 * Batch node-count check for `cherryPick()` / `revert()`: queries the
 * workspace's visible count once and compares it against `maxFiles` after
 * applying the planned write delta. Throws before any write happens.
 */
export const validateBatchNodeCount = op(async (
  ctx,
  tx: SqlClient,
  versionId: number,
  writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
  oursMap: Map<string, InternalEntryShape>,
): Promise<void> => {
    if (writes.length === 0) return;
    const currentCount = await ctx.globalVisibleCount(tx, versionId);
    let delta = 0;
    for (const w of writes) {
      const wasVisible = oursMap.has(w.internalPath);
      const willBeVisible = w.shape !== null;
      if (wasVisible && !willBeVisible) delta -= 1;
      else if (!wasVisible && willBeVisible) delta += 1;
    }
    if (currentCount + delta > ctx.maxFiles) {
      throw new Error(
        `Node limit reached: ${ctx.maxFiles} nodes per workspace`,
      );
    }
  });
