import type {
  ConflictEntry,
  MergeOptions,
  MergeResolution,
  MergeResult,
  MergeSide,
  MergeStrategy,
  SqlClient,
} from "../../types.js";
import { FsError } from "../../types.js";
import { bytesKey, sha256 } from "../internals/hashes.js";
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
 * Resolver: `resolve` is called for each conflict whose present sides are
 * all regular files, with the three texts, before the strategy applies. A
 * returned `{ content }` / `{ remove: true }` settles the path (listed in
 * `resolved`, and in `applied` or `skipped`); `undefined` leaves it a
 * conflict. `includeContent` adds the three texts to each `ConflictEntry`.
 * Blob contents are fetched in one query, only for conflicting paths, and
 * only when either option is set.
 *
 * Filters: `paths` matches each entry as either an exact path or a path
 * prefix (so a directory entry pulls in its descendants visible in any of
 * base/ours/theirs); `pathScope` restricts to one subtree; supplying both
 * intersects them. `dryRun: true` returns the same `MergeResult` without
 * writing.
 *
 * Source and base are read-only. Only the current destination version
 * receives `fs_entries` writes; `parent_version_id` and `version_ancestors`
 * are never modified. A frozen destination is refused with `EPERM`.
 *
 * Merge parents: a full merge (no `paths`/`pathScope`, not a dry run, not
 * refused) of a frozen source records `(destination, source)` in
 * `fs_version_merges`, so later merge bases account for it. An unfrozen
 * source is not recorded: it could change after the merge. Nor is a
 * fast-forward (destination an ancestor of source), which would make a
 * cycle.
 *
 * Implicit parent directories: when an applied non-null file or symlink
 * lands under a path whose ancestors are not visible in the destination,
 * those ancestors are copied from the source view (theirs preferred, then
 * ours, then base) and reported in `applied`.
 */
export const merge = op(async (
  ctx,
  source: string,
  opts?: MergeOptions,
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
      const frozen = await tx.query<{ id: number | string }>(
        `SELECT id FROM fs_versions
         WHERE workspace_id = $1 AND id = ANY($2::bigint[])
           AND frozen_at IS NOT NULL`,
        [ctx.workspaceId, [ourId, theirId]],
      );
      const frozenIds = new Set(frozen.rows.map((r) => Number(r.id)));
      if (frozenIds.has(ourId)) {
        throw new FsError("EPERM", "merge: destination version is frozen", "/");
      }

      // LCA & ancestor fast-path. If source is itself an ancestor of current,
      // current already includes it via the live overlay, so there is nothing
      // to apply. (If current is an ancestor of source, we still want to
      // fast-forward, so we don't short-circuit on lcaId === ourId.)
      const lcaId = await ctx.findLCA(tx, ourId, theirId);
      if (lcaId === theirId) {
        return { applied: [], conflicts: [], skipped: [], resolved: [] };
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
      const resolved: string[] = [];
      const conflicts: ConflictEntry[] = [];
      const rawConflicts: Array<{
        internalPath: string;
        base: InternalEntryShape | null;
        ours: InternalEntryShape | null;
        theirs: InternalEntryShape | null;
      }> = [];
      // Resolver output waiting for its blob to be stored (after the
      // strategy check, so a refused merge stores nothing).
      const pendingBlobs: Array<{ internalPath: string; content: string | Uint8Array }> = [];
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

        rawConflicts.push({ internalPath, base, ours, theirs });
      }

      const texts =
        rawConflicts.length > 0 && (opts?.resolve || opts?.includeContent)
          ? await fetchBlobTexts(
              tx,
              ctx.workspaceId,
              rawConflicts.flatMap((c) => [c.base, c.ours, c.theirs]),
            )
          : null;
      const textOf = (s: InternalEntryShape | null): string | null =>
        texts === null ? null : sideText(s, texts);

      for (const { internalPath, base, ours, theirs } of rawConflicts) {
        const userPath = ctx.toUserPath(internalPath);

        if (opts?.resolve && resolvable(base, ours, theirs)) {
          const side = (s: InternalEntryShape | null): MergeSide | null => {
            const pub = toPublicEntryShape(s);
            return pub === null ? null : { ...pub, content: textOf(s) };
          };
          const resolution: MergeResolution | null | undefined =
            await opts.resolve({
              path: userPath,
              base: side(base),
              ours: side(ours),
              theirs: side(theirs),
            });
          if (resolution) {
            let shape: InternalEntryShape | null = null;
            if ("content" in resolution) {
              const bytes =
                typeof resolution.content === "string"
                  ? new TextEncoder().encode(resolution.content)
                  : resolution.content;
              shape = {
                type: "file",
                blobHash: sha256(bytes),
                symlinkTarget: null,
                mode: ours?.mode ?? theirs?.mode ?? base?.mode ?? 0o644,
                sizeBytes: bytes.byteLength,
                mtime: new Date(),
              };
            }
            resolved.push(userPath);
            if (entryShapeEqual(ours, shape)) {
              skipped.push(userPath);
            } else {
              if ("content" in resolution) {
                pendingBlobs.push({ internalPath, content: resolution.content });
              }
              writes.push({ internalPath, shape });
              writePathSet.add(internalPath);
              applied.push(userPath);
            }
            continue;
          }
        }

        const conflict: ConflictEntry = {
          path: userPath,
          base: toPublicEntryShape(base),
          ours: toPublicEntryShape(ours),
          theirs: toPublicEntryShape(theirs),
        };
        if (opts?.includeContent) {
          conflict.baseContent = textOf(base);
          conflict.oursContent = textOf(ours);
          conflict.theirsContent = textOf(theirs);
        }

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
        return { applied: [], conflicts, skipped: [], resolved: [] };
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

      if (
        !dryRun &&
        frozenIds.has(theirId) &&
        lcaId !== ourId &&
        pathFilters.length === 0 &&
        scopeUser === "/"
      ) {
        await tx.query(
          `INSERT INTO fs_version_merges (workspace_id, version_id, source_id)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [ctx.workspaceId, ourId, theirId],
        );
      }

      if (dryRun || writes.length === 0) {
        return { applied, conflicts, skipped, resolved };
      }

      await ctx.lockVersions(tx, [ourId]);
      for (const b of pendingBlobs) {
        await ctx.storeBlob(tx, b.internalPath, b.content);
      }
      writes.sort((a, b) =>
        a.internalPath < b.internalPath ? -1
        : a.internalPath > b.internalPath ? 1
        : 0,
      );
      await ctx.writeEntryShapes(tx, ourId, writes);

      return { applied, conflicts, skipped, resolved };
    });
  });

/** A conflict goes to the resolver when every side present is a regular file. */
function resolvable(
  ...sides: Array<InternalEntryShape | null>
): boolean {
  return sides.every((s) => s === null || s.type === "file");
}

interface BlobText {
  content: string | null;
  binary: Uint8Array | null;
}

/** Contents of the blobs behind `sides`, keyed by hex hash, in one query. */
async function fetchBlobTexts(
  tx: SqlClient,
  workspaceId: string,
  sides: Array<InternalEntryShape | null>,
): Promise<Map<string, BlobText>> {
  const hashes = new Map<string, Uint8Array>();
  for (const s of sides) {
    if (s?.type === "file" && s.blobHash) hashes.set(bytesKey(s.blobHash), s.blobHash);
  }
  const out = new Map<string, BlobText>();
  if (hashes.size === 0) return out;
  const r = await tx.query<{ hash: Uint8Array; content: string | null; binary_data: Uint8Array | null }>(
    `SELECT hash, content, binary_data FROM fs_blobs
     WHERE workspace_id = $1
       AND hash = ANY(ARRAY(SELECT decode(h, 'hex') FROM unnest($2::text[]) AS h))`,
    [workspaceId, [...hashes.keys()]],
  );
  for (const row of r.rows) {
    out.set(bytesKey(row.hash), { content: row.content, binary: row.binary_data });
  }
  return out;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A file side's text: `null` for non-files and blobs that are not UTF-8. */
function sideText(
  s: InternalEntryShape | null,
  texts: Map<string, BlobText>,
): string | null {
  if (s === null || s.type !== "file") return null;
  if (!s.blobHash) return "";
  const blob = texts.get(bytesKey(s.blobHash));
  if (!blob) return null;
  if (blob.content !== null) return blob.content;
  if (blob.binary === null) return "";
  try {
    return strictUtf8.decode(blob.binary);
  } catch {
    return null;
  }
}
