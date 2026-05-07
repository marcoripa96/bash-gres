import { FsError } from "../../types.js";
import { parentPath } from "../../path-encoding.js";
import type { InternalEntryShape } from "../internals/entry-shapes.js";
import { op } from "./context.js";

/**
 * Walk parent paths up from each non-null file/symlink write. If a parent
 * is missing in the post-apply view, copy it from the first source map that
 * has a directory at that path (`sources` checked in order). Mutates
 * `writes`, `writePathSet`, and `applied` in place. Used by `cherryPick()`
 * and `revert()`; `merge()` inlines the same logic with a base map.
 */
export const expandParentDirectories = op((
  ctx,
  writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
  writePathSet: Set<string>,
  applied: string[],
  oursMap: Map<string, InternalEntryShape>,
  sources: Array<Map<string, InternalEntryShape>>,
  op: string,
): void => {
    const post = new Map(oursMap);
    for (const w of writes) {
      if (w.shape === null) post.delete(w.internalPath);
      else post.set(w.internalPath, w.shape);
    }
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
            `${op}: parent path is not a directory`,
            ctx.toUserPath(p),
          );
        }
        if (p === "/") {
          throw new Error(
            `${op}: root directory not visible in destination`,
          );
        }
        let srcDir: InternalEntryShape | undefined;
        for (const m of sources) {
          const v2 = m.get(p);
          if (v2 && v2.type === "directory") {
            srcDir = v2;
            break;
          }
        }
        if (!srcDir) {
          throw new Error(
            `${op}: cannot create implicit parent directory '${ctx.toUserPath(p)}': source view has no directory at this path`,
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
  });
