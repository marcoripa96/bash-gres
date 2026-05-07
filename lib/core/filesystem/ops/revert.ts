import type { MergeResult } from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import {
  entryShapeEqual,
  type InternalEntryShape,
} from "../internals/entry-shapes.js";
import { op } from "./context.js";
import { expandParentDirectories } from "./expand-parent-directories.js";
import { validateBatchNodeCount } from "./validate-batch-node-count.js";

/**
 * Restore the current version's selected visible tree to match `target`.
 * For every in-scope path:
 *   - visible in target → write target's entry shape to current.
 *   - visible only in current → write a tombstone.
 * No LCA, no conflicts. Returns a `MergeResult` for observability;
 * `conflicts` is always empty.
 *
 * `paths` and `pathScope` filter the operation as in `merge()`. `pathScope`
 * does NOT need to be visible in destination — revert is the natural way to
 * bring back a deleted subtree, so the scope is treated as a fetch boundary
 * and parent expansion materializes parents from target as needed.
 */
export const revert = op(async (
  ctx,
  target: string,
  opts?: { paths?: string[]; pathScope?: string },
): Promise<MergeResult> => {
    if (!target || target.length === 0) {
      throw new Error("revert: target must be a non-empty version label");
    }
    if (target === ctx.versionLabel) {
      throw new Error(
        `revert: target must differ from current version '${ctx.versionLabel}'`,
      );
    }

    const scopeUser = opts?.pathScope ? normalizePath(opts.pathScope) : "/";
    ctx.guardRead(scopeUser);
    const internalScope = ctx.toInternalPath(scopeUser);

    const pathFilters: string[] = [];
    if (opts?.paths && opts.paths.length > 0) {
      for (const p of opts.paths) {
        ctx.guardRead(p);
        pathFilters.push(ctx.toInternalPath(normalizePath(p)));
      }
    }

    return ctx.withWorkspace(async (tx) => {
      const ourId = await ctx.getCurrentVersionId(tx);
      const theirId = await ctx.requireVersionIdByLabel(tx, target);
      const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);

      const oursMap = await ctx.fetchVisibleEntryMap(tx, ourId, scopeLtree);
      const theirsMap = await ctx.fetchVisibleEntryMap(tx, theirId, scopeLtree);

      const candidatePaths = new Set<string>();
      for (const p of oursMap.keys()) candidatePaths.add(p);
      for (const p of theirsMap.keys()) candidatePaths.add(p);

      let candidates: string[];
      if (pathFilters.length > 0) {
        candidates = [...candidatePaths].filter((c) =>
          pathFilters.some((f) =>
            c === f ||
            (f === "/" ? c.startsWith("/") : c.startsWith(f + "/")),
          ),
        );
      } else {
        candidates = [...candidatePaths];
      }
      candidates.sort();

      const applied: string[] = [];
      const skipped: string[] = [];
      const writes: Array<{
        internalPath: string;
        shape: InternalEntryShape | null;
      }> = [];
      const writePathSet = new Set<string>();

      for (const internalPath of candidates) {
        const ours = oursMap.get(internalPath) ?? null;
        const theirs = theirsMap.get(internalPath) ?? null;
        const userPath = ctx.toUserPath(internalPath);

        if (entryShapeEqual(ours, theirs)) {
          skipped.push(userPath);
          continue;
        }
        writes.push({ internalPath, shape: theirs });
        writePathSet.add(internalPath);
        applied.push(userPath);
      }

      expandParentDirectories(
        ctx,
        writes,
        writePathSet,
        applied,
        oursMap,
        [theirsMap, oursMap],
        "revert",
      );

      await validateBatchNodeCount(ctx, tx, ourId, writes, oursMap);

      applied.sort();
      skipped.sort();

      if (writes.length === 0) {
        return { applied, conflicts: [], skipped };
      }

      await ctx.lockVersions(tx, [ourId]);
      writes.sort((a, b) =>
        a.internalPath < b.internalPath ? -1
        : a.internalPath > b.internalPath ? 1
        : 0,
      );
      for (const w of writes) {
        await ctx.writeEntryShape(tx, ourId, w.internalPath, w.shape);
      }

      return { applied, conflicts: [], skipped };
    });
  });
