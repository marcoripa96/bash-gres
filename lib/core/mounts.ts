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
 * without remapping paths or wrapping the instance in a router.
 *
 * Mount roots are grouped by depth so the cost of a check scales with the
 * number of distinct root depths, not the number of mounts (a view can carry
 * thousands of sibling mounts like `/clients/<code>`). A path is inside a mount
 * iff its prefix at some root depth is one of the roots at that depth, and it
 * is an ancestor of a mount iff it is in the precomputed set of strict root
 * ancestors. In SQL that becomes one hashed set-membership test per depth:
 *
 *     subpath(path, 0, d1)::text IN (SELECT unnest($a::text[]))  -- depth d1
 *  OR subpath(path, 0, d2)::text IN (SELECT unnest($b::text[]))  -- depth d2
 *  OR path::text IN (SELECT unnest($anc::text[]))                -- ancestors
 *
 * The `IN (SELECT unnest(...))` form plans as a hashed SubPlan even under a
 * generic plan for a reused prepared statement, where `= ANY($n)` would fall
 * back to a linear scan of the array per row. Comparing as text keeps the
 * hashing independent of the ltree extension version.
 */
export interface CompiledMounts {
  empty: boolean;
  /** True when `/` itself is mounted: every path is visible, only writes are scoped. */
  coversAll: boolean;
  /** Internal POSIX mount root -> readonly flag. */
  byRoot: ReadonlyMap<string, boolean>;
  /** Distinct root depths (path segment count), ascending. */
  depths: number[];
  /** Internal POSIX mount roots grouped by depth. */
  rootsByDepth: ReadonlyMap<number, ReadonlySet<string>>;
  /** Strict ancestors of every mount root, as internal POSIX paths. */
  ancestors: ReadonlySet<string>;
  /** ltree-encoded roots per depth; `nlevel` counts the workspace label. */
  ltreesByDepth: Array<{ nlevel: number; ltrees: string[] }>;
  /** ltree-encoded strict ancestors of every mount root. */
  ancestorLtrees: string[];
}

const EMPTY: CompiledMounts = Object.freeze({
  empty: true,
  coversAll: false,
  byRoot: new Map<string, boolean>(),
  depths: [],
  rootsByDepth: new Map<number, ReadonlySet<string>>(),
  ancestors: new Set<string>(),
  ltreesByDepth: [],
  ancestorLtrees: [],
});

export function emptyMounts(): CompiledMounts {
  return EMPTY;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function prefixOf(segments: string[], depth: number): string {
  return "/" + segments.slice(0, depth).join("/");
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

  const rootsByDepth = new Map<number, Set<string>>();
  const ancestors = new Set<string>();
  for (const root of byRoot.keys()) {
    const segments = segmentsOf(root);
    const depth = segments.length;
    let roots = rootsByDepth.get(depth);
    if (!roots) {
      roots = new Set<string>();
      rootsByDepth.set(depth, roots);
    }
    roots.add(root);
    for (let d = 0; d < depth; d++) ancestors.add(prefixOf(segments, d));
  }

  const depths = [...rootsByDepth.keys()].sort((a, b) => a - b);
  const ltreesByDepth = depths.map((depth) => ({
    // +1 for the `w_<workspace>` label every ltree path starts with.
    nlevel: depth + 1,
    ltrees: [...rootsByDepth.get(depth)!].map((r) =>
      pathToLtree(r, workspaceId),
    ),
  }));
  const ancestorLtrees = [...ancestors].map((a) => pathToLtree(a, workspaceId));

  return {
    empty: false,
    coversAll: byRoot.has("/"),
    byRoot,
    depths,
    rootsByDepth,
    ancestors,
    ltreesByDepth,
    ancestorLtrees,
  };
}

/**
 * True when `internalPath` is inside a mount, or is an ancestor directory of
 * one (so intermediate dirs like `/users` and `/clienti` remain walkable, and
 * `/` always lists the branches that lead to mounts).
 */
export function mountVisible(c: CompiledMounts, internalPath: string): boolean {
  if (c.empty || c.coversAll) return true;
  if (internalPath === "/") return true;
  const segments = segmentsOf(internalPath);
  for (const depth of c.depths) {
    if (depth > segments.length) break;
    if (c.rootsByDepth.get(depth)!.has(prefixOf(segments, depth))) return true;
  }
  return c.ancestors.has(internalPath);
}

/**
 * True when `internalPath` is inside a non-readonly mount. The deepest
 * enclosing mount decides, so a readonly mount nested under a writable one (or
 * the reverse) carves out its own subtree.
 */
export function mountWritable(
  c: CompiledMounts,
  internalPath: string,
): boolean {
  if (c.empty) return true;
  const segments = segmentsOf(internalPath);
  for (let i = c.depths.length - 1; i >= 0; i--) {
    const depth = c.depths[i]!;
    if (depth > segments.length) continue;
    const readonly = c.byRoot.get(prefixOf(segments, depth));
    if (readonly !== undefined) return !readonly;
  }
  return false;
}

/**
 * Build the SQL fragment that, ANDed into a `WHERE` clause, keeps only entries
 * inside a mount or on an ancestor path leading to one. Returns `TRUE` (no-op)
 * when no mounts are configured or `/` itself is mounted.
 *
 * `pathExpr` names the ltree path column (e.g. `e.path`). Emits one `text[]`
 * param per distinct root depth, plus one for the ancestor set when non-empty.
 * `subpath` clips to the path's own length, so a path shallower than a depth
 * yields a prefix that can never equal a root at that depth.
 */
export function mountWhereSql(
  c: CompiledMounts,
  pathExpr: string,
  nextParamIdx: number,
): { sql: string; params: SqlParam[] } {
  if (c.empty || c.coversAll) return { sql: "TRUE", params: [] };
  const disjuncts: string[] = [];
  const params: SqlParam[] = [];
  let idx = nextParamIdx;
  for (const { nlevel, ltrees } of c.ltreesByDepth) {
    disjuncts.push(
      `subpath(${pathExpr}, 0, ${nlevel})::text IN (SELECT unnest($${idx++}::text[]))`,
    );
    params.push(ltrees);
  }
  if (c.ancestorLtrees.length > 0) {
    disjuncts.push(
      `${pathExpr}::text IN (SELECT unnest($${idx++}::text[]))`,
    );
    params.push(c.ancestorLtrees);
  }
  return { sql: `(${disjuncts.join(" OR ")})`, params };
}
