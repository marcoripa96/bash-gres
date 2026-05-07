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
 * Copy selected visible paths from `source` into the current version.
 * Source-wins, two-way: there is no LCA, no conflict reporting; for each
 * selected path either source's shape replaces destination's or — when the
 * path exists in destination but not source — a tombstone is written.
 *
 * Each entry in `paths` is a user path. A directory match (in either side)
 * pulls in the entire visible subtree. Equal paths are reported in
 * `skipped`. `conflicts` is always empty.
 *
 * Implicit parent directories: when an applied non-null file or symlink
 * lands under a path whose ancestors are not visible in the destination,
 * those ancestors are copied from the source view (theirs preferred, then
 * ours) and reported in `applied`.
 */
export const cherryPick = op(async (
  ctx,
  source: string,
  paths: string[],
): Promise<MergeResult> => {
    if (!source || source.length === 0) {
      throw new Error("cherryPick: source must be a non-empty version label");
    }
    if (source === ctx.versionLabel) {
      throw new Error(
        `cherryPick: source must differ from current version '${ctx.versionLabel}'`,
      );
    }
    if (!paths || paths.length === 0) {
      throw new Error("cherryPick: paths must be a non-empty array");
    }

    const pathFilters: string[] = [];
    for (const p of paths) {
      ctx.guardRead(p);
      pathFilters.push(ctx.toInternalPath(normalizePath(p)));
    }

    return ctx.withWorkspace(async (tx) => {
      const ourId = await ctx.getCurrentVersionId(tx);
      const theirId = await ctx.requireVersionIdByLabel(tx, source);
      const rootLtree = pathToLtree("/", ctx.workspaceId);

      const oursMap = await ctx.fetchVisibleEntryMap(tx, ourId, rootLtree);
      const theirsMap = await ctx.fetchVisibleEntryMap(tx, theirId, rootLtree);

      // Candidate paths = union(ours, theirs) restricted to filter. Filter `f`
      // matches `c` iff `c === f` or `c` is a strict descendant of `f`.
      const candidatePaths = new Set<string>();
      for (const p of oursMap.keys()) candidatePaths.add(p);
      for (const p of theirsMap.keys()) candidatePaths.add(p);

      const candidates = [...candidatePaths]
        .filter((c) =>
          pathFilters.some((f) =>
            c === f ||
            (f === "/" ? c.startsWith("/") : c.startsWith(f + "/")),
          ),
        )
        .sort();

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
        // Source wins. `theirs === null` becomes a tombstone.
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
        "cherryPick",
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
