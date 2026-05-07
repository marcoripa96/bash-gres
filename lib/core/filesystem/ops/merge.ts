import type { ConflictEntry, MergeResult, MergeStrategy } from "../../types.js";
import { FsError } from "../../types.js";
import { pathToLtree, normalizePath, parentPath } from "../../path-encoding.js";
import {
  entryShapeEqual,
  toPublicEntryShape,
  type InternalEntryShape,
} from "../internals/entry-shapes.js";
import { op } from "./context.js";

/**
 * Apply path-level changes from `source` into the current version using a
 * three-way comparison against the LCA. Equality is over `node_type`,
 * `blob_hash`, `mode`, and `symlink_target` (mtime/size_bytes ignored).
 *
 * Classification (one rule covers the whole conflict matrix):
 *
 *   - `ours == theirs` (semantically): skip (no-op).
 *   - else `base == ours`: only theirs changed -> apply theirs.
 *   - else `base == theirs`: only ours changed -> keep ours.
 *   - else: conflict.
 *
 * `null` (deleted / never-existed) compares like any other value, so the
 * deletion rows in the proposal's matrix collapse cleanly: `(- - X)` ->
 * `base == ours` -> apply (add); `(X X -)` -> `base == ours` -> apply
 * tombstone; `(X - X)` -> `base == theirs` -> skip; etc.
 *
 * Strategies on conflict:
 *
 *   - `fail` (default): no writes; conflicts returned, applied/skipped both
 *     empty.
 *   - `ours`: keep destination, conflicts still reported, path goes in
 *     `skipped`.
 *   - `theirs`: apply source, conflicts still reported (so callers can see
 *     the override), path goes in `applied`.
 *
 * Filters: `paths` matches each entry as either an exact path or a path
 * prefix (so a directory entry pulls in its descendants visible in any of
 * base/ours/theirs); `pathScope` restricts to one subtree; supplying both
 * intersects them. `dryRun: true` returns the same `MergeResult` without
 * writing.
 *
 * Source and base are read-only. Only the current destination version
 * receives `fs_entries` writes; `parent_version_id` and `version_ancestors`
 * are never modified.
 *
 * Implicit parent directories: when an applied non-null file or symlink
 * lands under a path whose ancestors are not visible in the destination,
 * those ancestors are copied from the source view (theirs preferred, then
 * ours, then base) and reported in `applied`.
 */
export const merge = op(async (
  ctx,
  source: string,
  opts?: {
    strategy?: MergeStrategy;
    paths?: string[];
    pathScope?: string;
    dryRun?: boolean;
  },
): Promise<MergeResult> => {
    if (!source || source.length === 0) {
      throw new Error("merge: source must be a non-empty version label");
    }
    if (source === ctx.versionLabel) {
      throw new Error(
        `merge: source must differ from current version '${ctx.versionLabel}'`,
      );
    }
    const strategy: MergeStrategy = opts?.strategy ?? "fail";
    const dryRun = opts?.dryRun ?? false;

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
      const theirId = await ctx.requireVersionIdByLabel(tx, source);
      const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);

      // LCA & ancestor fast-path. If source is itself an ancestor of current,
      // current already includes it via the live overlay, so there is nothing
      // to apply. (If current is an ancestor of source, we still want to
      // fast-forward, so we don't short-circuit on lcaId === ourId.)
      const lcaId = await ctx.findLCA(tx, ourId, theirId);
      if (lcaId === theirId) {
        return { applied: [], conflicts: [], skipped: [] };
      }

      const oursMap = await ctx.fetchVisibleEntryMap(tx, ourId, scopeLtree);
      const theirsMap = await ctx.fetchVisibleEntryMap(tx, theirId, scopeLtree);
      const baseMap =
        lcaId !== null
          ? await ctx.fetchVisibleEntryMap(tx, lcaId, scopeLtree)
          : new Map<string, InternalEntryShape>();

      // Validate scope visibility in destination — parent-dir expansion needs
      // a known-good directory at the scope boundary so it never escapes.
      // Root scope ("/") is always visible after init().
      if (internalScope !== "/") {
        const scopeOurs = oursMap.get(internalScope);
        if (!scopeOurs || scopeOurs.type !== "directory") {
          throw new FsError(
            "ENOTDIR",
            "merge: pathScope is not a visible directory in destination",
            ctx.toUserPath(internalScope),
          );
        }
      }

      // Candidate paths = union of all three maps, restricted by `paths`
      // filter when provided. A user-supplied filter `f` matches candidate
      // `c` iff `c === f` or `c` is a strict descendant of `f`. This treats
      // directory-shaped filters as "the directory plus its visible subtree"
      // without first deciding whether `f` is actually a directory in any
      // particular side.
      const candidatePaths = new Set<string>();
      for (const p of oursMap.keys()) candidatePaths.add(p);
      for (const p of theirsMap.keys()) candidatePaths.add(p);
      for (const p of baseMap.keys()) candidatePaths.add(p);

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
      const conflicts: ConflictEntry[] = [];
      const writes: Array<{
        internalPath: string;
        shape: InternalEntryShape | null;
      }> = [];
      const writePathSet = new Set<string>();

      for (const internalPath of candidates) {
        const ours = oursMap.get(internalPath) ?? null;
        const theirs = theirsMap.get(internalPath) ?? null;
        const base = baseMap.get(internalPath) ?? null;
        const userPath = ctx.toUserPath(internalPath);

        if (entryShapeEqual(ours, theirs)) {
          skipped.push(userPath);
          continue;
        }
        if (entryShapeEqual(base, ours)) {
          writes.push({ internalPath, shape: theirs });
          writePathSet.add(internalPath);
          applied.push(userPath);
          continue;
        }
        if (entryShapeEqual(base, theirs)) {
          skipped.push(userPath);
          continue;
        }

        const conflict: ConflictEntry = {
          path: userPath,
          base: toPublicEntryShape(base),
          ours: toPublicEntryShape(ours),
          theirs: toPublicEntryShape(theirs),
        };

        if (strategy === "fail") {
          conflicts.push(conflict);
        } else if (strategy === "ours") {
          conflicts.push(conflict);
          skipped.push(userPath);
        } else {
          conflicts.push(conflict);
          writes.push({ internalPath, shape: theirs });
          writePathSet.add(internalPath);
          applied.push(userPath);
        }
      }

      if (strategy === "fail" && conflicts.length > 0) {
        return { applied: [], conflicts, skipped: [] };
      }

      // Post-apply visible map (within scope) for parent expansion.
      const post = new Map(oursMap);
      for (const w of writes) {
        if (w.shape === null) post.delete(w.internalPath);
        else post.set(w.internalPath, w.shape);
      }

      // Parent-directory expansion for non-null file/symlink writes. The
      // scope check above guarantees a visible directory at `internalScope`,
      // so this walk always terminates: either we hit a visible directory in
      // post (oursMap or a write we just queued), or we reach scope itself
      // which is guaranteed visible.
      const initialWrites = writes.slice();
      for (const w of initialWrites) {
        if (w.shape === null) continue;
        if (w.shape.type !== "file" && w.shape.type !== "symlink") continue;
        let p = parentPath(w.internalPath);
        while (true) {
          const v = post.get(p);
          if (v?.type === "directory") break;
          if (v) {
            throw new FsError(
              "ENOTDIR",
              "merge: parent path is not a directory",
              ctx.toUserPath(p),
            );
          }
          if (p === "/") {
            // Root must always exist after init(). If we ever reach here it
            // means the workspace is corrupt.
            throw new Error(
              "merge: root directory not visible in destination",
            );
          }
          const srcDir =
            theirsMap.get(p) ?? oursMap.get(p) ?? baseMap.get(p);
          if (!srcDir || srcDir.type !== "directory") {
            throw new Error(
              `merge: cannot create implicit parent directory '${ctx.toUserPath(p)}': source view has no directory at this path`,
            );
          }
          if (!writePathSet.has(p)) {
            writes.push({ internalPath: p, shape: srcDir });
            writePathSet.add(p);
            applied.push(ctx.toUserPath(p));
          }
          post.set(p, srcDir);
          p = parentPath(p);
        }
      }

      // Batch node-count validation: query the global visible count once,
      // compute the net delta, and check `maxFiles` before any writes happen.
      // Existing single-path writes still call `validateNodeCount()` on their
      // own; merge sidesteps that loop because it knows the full apply set
      // up-front.
      if (writes.length > 0) {
        const currentCount = await ctx.globalVisibleCount(tx, ourId);
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
      }

      applied.sort();
      skipped.sort();

      if (dryRun || writes.length === 0) {
        return { applied, conflicts, skipped };
      }

      await ctx.lockVersions(tx, [ourId]);
      writes.sort((a, b) =>
        a.internalPath < b.internalPath ? -1
        : a.internalPath > b.internalPath ? 1
        : 0,
      );
      await ctx.writeEntryShapes(tx, ourId, writes);

      return { applied, conflicts, skipped };
    });
  });
