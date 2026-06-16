import type { MountSpec, SqlParam } from "./types.js";
import { normalizePath, pathToLtree } from "./path-encoding.js";

/**
 * Pre-compiled mount set: an allow-list of workspace subtrees this instance is
 * restricted to. Unlike `exclude` (a deny-list), mounts are default-deny — a
 * path is only visible if it lives inside a mount or is an ancestor directory
 * leading down to one.
 *
 * This is what lets a single `PgFileSystem` over one workspace present a
 * scoped per-user view (`/users/<id>` + `/general` + a few `/clienti/<x>`)
 * without remapping paths or wrapping the instance in a router. The visible
 * set is expressed in SQL as
 *
 *     path <@ ANY(ltrees)   -- inside a mount
 *  OR path @> ANY(ltrees)   -- an ancestor of a mount (so `ls /` walks down)
 *
 * which is GiST-indexed, and mirrored in JS by `mountVisible` for the
 * single-path read/write guards.
 */
export interface CompiledMounts {
  empty: boolean;
  /** Internal POSIX roots of every mount. */
  roots: string[];
  /** Internal POSIX roots of writable (non-readonly) mounts. */
  writableRoots: string[];
  /** Internal POSIX roots of readonly mounts. */
  readonlyRoots: string[];
  /** ltree-encoded roots, for `path <@ ANY(...)` / `path @> ANY(...)` pushdown. */
  ltrees: string[];
  /** Mounts with their readonly flag, used for most-specific write decisions. */
  entries: Array<{ root: string; readonly: boolean }>;
}

const EMPTY: CompiledMounts = Object.freeze({
  empty: true,
  roots: [],
  writableRoots: [],
  readonlyRoots: [],
  ltrees: [],
  entries: [],
});

export function emptyMounts(): CompiledMounts {
  return EMPTY;
}

/**
 * Compile a list of mount specs into the form used by `mountWhereSql()` and
 * the `mountVisible`/`mountWritable` predicates. Each spec's `path` is resolved
 * relative to `rootDirInternal` (normally `/`, i.e. identity).
 *
 * Returns the shared empty singleton when there are no specs, or when a writable
 * root mount is the only meaningful restriction. Readonly root mounts and
 * readonly children under a writable root still matter for write guards, so
 * those remain non-empty even though they expose the whole tree.
 */
export function compileMounts(
  specs: MountSpec[] | undefined,
  rootDirInternal: string,
  workspaceId: string,
): CompiledMounts {
  if (!specs || specs.length === 0) return EMPTY;

  const byRoot = new Map<string, boolean>();

  for (const spec of specs) {
    const userPath = normalizePath(spec.path);
    const internal =
      rootDirInternal === "/"
        ? userPath
        : userPath === "/"
          ? rootDirInternal
          : normalizePath(rootDirInternal + userPath);

    const readonly = spec.readonly === true;
    const prev = byRoot.get(internal);
    if (prev !== undefined) {
      // A writable spec wins for duplicate exact paths, preserving the previous
      // behavior where a later writable spec upgrades an earlier readonly one.
      if (!readonly) byRoot.set(internal, false);
      continue;
    }
    byRoot.set(internal, readonly);
  }

  if (byRoot.size === 0) return EMPTY;

  const hasWritableRoot = byRoot.get("/") === false;
  const hasReadonlyMount = [...byRoot.values()].some((readonly) => readonly);
  if (hasWritableRoot && !hasReadonlyMount) return EMPTY;

  const roots: string[] = [];
  const writableRoots: string[] = [];
  const readonlyRoots: string[] = [];
  const ltrees: string[] = [];
  const entries: Array<{ root: string; readonly: boolean }> = [];
  for (const [root, readonly] of byRoot) {
    roots.push(root);
    ltrees.push(pathToLtree(root, workspaceId));
    entries.push({ root, readonly });
    if (readonly) readonlyRoots.push(root);
    else writableRoots.push(root);
  }

  return { empty: false, roots, writableRoots, readonlyRoots, ltrees, entries };
}

function isUnder(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/");
  return path === root || path.startsWith(root + "/");
}

/**
 * True when `internalPath` is inside a mount, or is an ancestor directory of
 * one (so intermediate dirs like `/users` and `/clienti` remain walkable, and
 * `/` always lists the branches that lead to mounts).
 */
export function mountVisible(c: CompiledMounts, internalPath: string): boolean {
  if (c.empty) return true;
  if (internalPath === "/") return true;
  for (const r of c.roots) {
    if (isUnder(internalPath, r)) return true; // inside a mount
    if (isUnder(r, internalPath)) return true; // ancestor of a mount
  }
  return false;
}

/** True when `internalPath` is inside a non-readonly mount. */
export function mountWritable(
  c: CompiledMounts,
  internalPath: string,
): boolean {
  if (c.empty) return true;
  let best: { root: string; readonly: boolean } | null = null;
  for (const entry of c.entries) {
    if (!isUnder(internalPath, entry.root)) continue;
    if (!best || entry.root.length > best.root.length) {
      best = entry;
    }
  }
  return best !== null && !best.readonly;
}

/**
 * Build the SQL fragment that, ANDed into a `WHERE` clause, keeps only entries
 * inside a mount or on an ancestor path leading to one. Returns `TRUE` (no-op)
 * when no mounts are configured.
 *
 * `pathExpr` names the ltree path column (e.g. `e.path`). The single array
 * param is referenced twice; every adapter resolves `$N` by position, so the
 * reuse is safe.
 */
export function mountWhereSql(
  c: CompiledMounts,
  pathExpr: string,
  nextParamIdx: number,
): { sql: string; params: SqlParam[] } {
  if (c.empty) return { sql: "TRUE", params: [] };
  const i = nextParamIdx;
  return {
    sql: `(${pathExpr} <@ ANY($${i}::ltree[]) OR ${pathExpr} @> ANY($${i}::ltree[]))`,
    params: [c.ltrees],
  };
}
