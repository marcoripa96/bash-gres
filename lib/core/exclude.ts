import type { SqlParam } from "./types.js";
import { encodeLabel, normalizePath, pathToLtree } from "./path-encoding.js";

/**
 * Pre-compiled exclude patterns, ready to be inlined into SQL WHERE clauses
 * and evaluated against single internal paths in JS.
 *
 * The hybrid pushdown strategy splits patterns into three buckets so the
 * fast, indexed paths handle as many cases as possible:
 *
 *   1. `lqueries`: label-level patterns (e.g. `node_modules`, `__pycache__`).
 *      Match via `path ~ ANY($n::lquery[])`, GiST-indexed.
 *   2. `prefixes`: anchored subtree prefixes (e.g. `/build`, `/.git`).
 *      Match via `path <@ ANY($n::ltree[])` plus exact equality, GiST-indexed.
 *   3. `regexes`: anything lquery cannot express (intra-label glob like
 *      `*.log`, `Dockerfile.*`, mixed-segment globs). Match via
 *      `path::text ~ ANY($n::text[])`. Sequential within the already
 *      narrowed result set.
 *
 * The compiled form is per-instance because anchored patterns are resolved
 * relative to `rootDir` and the workspace prefix in encoded ltree.
 */
export interface CompiledExcludes {
  empty: boolean;
  lqueries: string[];
  prefixes: string[];
  regexes: string[];
  /** Original raw patterns, kept for the JS-side predicate. */
  rawPatterns: CompiledRawPattern[];
  rootDirInternal: string;
}

interface CompiledRawPattern {
  /** Path-segment regex compiled for the JS predicate, applied to internal POSIX paths. */
  test: (internalPath: string) => boolean;
}

const EMPTY: CompiledExcludes = Object.freeze({
  empty: true,
  lqueries: [],
  prefixes: [],
  regexes: [],
  rawPatterns: [],
  rootDirInternal: "/",
});

export function emptyExcludes(): CompiledExcludes {
  return EMPTY;
}

/**
 * Compile a list of gitignore-like patterns into the hybrid form used by
 * `excludeWhereSql()` and `isExcluded()`.
 *
 * Supported syntax (subset of gitignore):
 *
 *   - `name`            — match a label called `name` anywhere in the tree.
 *   - `name/`           — same as `name` (dir-only semantics not enforced; see followups).
 *   - `/name`           — anchored at `rootDir`: match exact path and its subtree.
 *   - `/a/b/c`          — anchored multi-segment subtree.
 *   - `*.ext`           — leaf basename glob; matches files/dirs ending in `.ext` anywhere.
 *   - `name.*`          — leaf basename glob.
 *   - `**`/`name`       — equivalent to `name`.
 *   - `dir/*.tmp`       — anchored mixed-segment glob (full-path regex).
 *   - empty / `#…`      — ignored (gitignore comment).
 *
 * Negation (`!pat`) and dir-only enforcement (`name/` only matches dirs)
 * are not implemented in this pass.
 */
export function compileExcludes(
  patterns: string[] | undefined,
  rootDirInternal: string,
  workspaceId: string,
): CompiledExcludes {
  if (!patterns || patterns.length === 0) return EMPTY;

  const lqueries: string[] = [];
  const prefixes: string[] = [];
  const regexes: string[] = [];
  const rawPatterns: CompiledRawPattern[] = [];

  for (const raw of patterns) {
    const pat = raw.replace(/\s+$/, "");
    if (pat === "" || pat.startsWith("#")) continue;

    const compiled = compilePattern(pat, rootDirInternal, workspaceId);
    if (!compiled) continue;
    if (compiled.lquery) lqueries.push(compiled.lquery);
    if (compiled.prefix) prefixes.push(compiled.prefix);
    if (compiled.regex) regexes.push(compiled.regex);
    rawPatterns.push({ test: compiled.jsTest });
  }

  if (
    lqueries.length === 0 &&
    prefixes.length === 0 &&
    regexes.length === 0
  ) {
    return EMPTY;
  }

  return {
    empty: false,
    lqueries,
    prefixes,
    regexes,
    rawPatterns,
    rootDirInternal,
  };
}

interface PatternParts {
  lquery?: string;
  prefix?: string;
  regex?: string;
  jsTest: (internalPath: string) => boolean;
}

function compilePattern(
  raw: string,
  rootDirInternal: string,
  workspaceId: string,
): PatternParts | null {
  let pattern = raw;
  if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
  if (pattern === "") return null;

  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  const segments = pattern.split("/").filter((s) => s !== "");
  if (segments.length === 0) return null;

  const hasGlob = segments.some(hasGlobChars);
  const hasDoubleStar = segments.some((s) => s === "**");

  // Single literal segment, no anchor: label match anywhere via lquery.
  if (segments.length === 1 && !hasGlob && !anchored) {
    const seg = segments[0]!;
    return {
      lquery: `*.${encodeLabel(seg)}.*`,
      jsTest: makeLabelMatchTest(seg),
    };
  }

  // Single literal segment, anchored: subtree under rootDir.
  if (segments.length === 1 && !hasGlob && anchored) {
    const seg = segments[0]!;
    const fullInternal =
      rootDirInternal === "/" ? `/${seg}` : `${rootDirInternal}/${seg}`;
    const ltree = pathToLtree(fullInternal, workspaceId);
    return {
      prefix: ltree,
      jsTest: makePrefixTest(fullInternal),
    };
  }

  // `**/seg` (single seg after `**`, no other glob): same as bare label match.
  if (
    !anchored &&
    segments.length === 2 &&
    segments[0] === "**" &&
    !hasGlobChars(segments[1]!)
  ) {
    const seg = segments[1]!;
    return {
      lquery: `*.${encodeLabel(seg)}.*`,
      jsTest: makeLabelMatchTest(seg),
    };
  }

  // Single segment with glob, no anchor: leaf basename glob anywhere.
  if (segments.length === 1 && hasGlob && !anchored && !hasDoubleStar) {
    const seg = segments[0]!;
    const encodedRe = compileGlobToEncodedRegex(seg);
    // Match any label in the path, plus any descendants under it. We achieve
    // "plus descendants" by anchoring "before next `.` or end" rather than
    // strictly end-of-string.
    const regex = `(?:^|\\.)${encodedRe}(?:\\.|$)`;
    return {
      regex,
      jsTest: makeAnySegmentGlobTest(seg),
    };
  }

  // Multi-segment or mixed pattern: full-path regex, anchored or not.
  const rootLtree = pathToLtree(rootDirInternal, workspaceId);
  const body = buildSegmentRegex(segments);

  let regex: string;
  if (anchored) {
    regex = `^${escapeRegex(rootLtree)}\\.${body}(?:\\.|$)`;
  } else {
    regex = `^${escapeRegex(rootLtree)}\\.(?:[^.]+\\.)*${body}(?:\\.|$)`;
  }

  return {
    regex,
    jsTest: makeFullPathTest(segments, anchored, rootDirInternal),
  };
}

/**
 * Compose a path-segment list (e.g. `["a", "**", "b"]`) into a regex fragment
 * that operates on the encoded `path::text` form.
 *
 * `**` between two literal segments matches zero or more intermediate labels:
 *   `a/**\/b` → `a(?:\.[^.]+)*\.b`
 *
 * `**` at the start matches zero or more leading labels:
 *   `**\/x` → `(?:[^.]+\.)*x`
 *
 * `**` at the end matches zero or more trailing labels:
 *   `x/**` → `x(?:\.[^.]+)*`
 */
function buildSegmentRegex(segments: string[]): string {
  let body = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = i > 0 ? segments[i - 1] : null;
    const next = i < segments.length - 1 ? segments[i + 1] : null;
    if (seg === "**") {
      if (prev === null && next !== null) body += "(?:[^.]+\\.)*";
      else if (prev !== null && next === null) body += "(?:\\.[^.]+)*";
      else if (prev !== null && next !== null) body += "(?:\\.[^.]+)*\\.";
      else body += "(?:[^.]+\\.?)*";
    } else {
      const r = hasGlobChars(seg)
        ? compileGlobToEncodedRegex(seg)
        : escapeRegex(encodeLabel(seg));
      if (i > 0 && prev !== "**") body += "\\.";
      body += r;
    }
  }
  return body;
}

function hasGlobChars(s: string): boolean {
  return /[*?\[]/.test(s);
}

/**
 * Translate a single gitignore-style segment glob (no `/`) into a regex
 * fragment that operates on the *encoded* label form stored in `path::text`.
 *
 * Encoded labels never contain `.` (it's our label separator), `/` (path
 * separator), so we map gitignore wildcards as follows:
 *   `*` → `[^.]*`   (anything but a label boundary)
 *   `?` → encoded one-character; we approximate as `(?:[^.]|_x[0-9A-F]+_)`
 *   `[abc]` → translated by encoding each member
 *   any other char → its `encodeLabel` form, then regex-escaped
 */
function compileGlobToEncodedRegex(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    if (c === "*") {
      out += "[^.]*";
      i++;
    } else if (c === "?") {
      out += "(?:[A-Za-z0-9\\-]|_x[0-9A-Fa-f]{2,6}_)";
      i++;
    } else if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close === -1) {
        out += escapeRegex(encodeLabel(c));
        i++;
        continue;
      }
      const members = seg.slice(i + 1, close);
      const alts: string[] = [];
      let j = 0;
      while (j < members.length) {
        if (j + 2 < members.length && members[j + 1] === "-") {
          const a = members[j]!;
          const b = members[j + 2]!;
          for (
            let cp = a.codePointAt(0)!;
            cp <= b.codePointAt(0)!;
            cp++
          ) {
            alts.push(escapeRegex(encodeLabel(String.fromCodePoint(cp))));
          }
          j += 3;
        } else {
          alts.push(escapeRegex(encodeLabel(members[j]!)));
          j++;
        }
      }
      out += `(?:${alts.join("|")})`;
      i = close + 1;
    } else {
      out += escapeRegex(encodeLabel(c));
      i++;
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- JS-side predicates -----------------------------------------------------

function makeLabelMatchTest(label: string): (internalPath: string) => boolean {
  return (p) => {
    const segs = p.split("/").filter(Boolean);
    return segs.includes(label);
  };
}

function makePrefixTest(prefix: string): (internalPath: string) => boolean {
  return (p) => p === prefix || p.startsWith(prefix + "/");
}

function makeAnySegmentGlobTest(
  glob: string,
): (internalPath: string) => boolean {
  const re = new RegExp(`^${segmentGlobToJsRegex(glob)}$`);
  return (p) => {
    const segs = p.split("/").filter(Boolean);
    return segs.some((s) => re.test(s));
  };
}

function makeFullPathTest(
  segments: string[],
  anchored: boolean,
  rootDirInternal: string,
): (internalPath: string) => boolean {
  let body = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = i > 0 ? segments[i - 1] : null;
    const next = i < segments.length - 1 ? segments[i + 1] : null;
    if (seg === "**") {
      if (prev === null && next !== null) body += "(?:[^/]+/)*";
      else if (prev !== null && next === null) body += "(?:/[^/]+)*";
      else if (prev !== null && next !== null) body += "(?:/[^/]+)*/";
      else body += "(?:[^/]+/?)*";
    } else {
      const r = hasGlobChars(seg)
        ? segmentGlobToJsRegex(seg)
        : escapeRegex(seg);
      if (i > 0 && prev !== "**") body += "/";
      body += r;
    }
  }

  const root = rootDirInternal === "/" ? "" : escapeRegex(rootDirInternal);
  let pattern: string;
  if (anchored) {
    pattern = `^${root}/${body}(?:/.*)?$`;
  } else {
    pattern = `^${root}/(?:[^/]+/)*${body}(?:/.*)?$`;
  }
  const re = new RegExp(pattern);
  return (p) => re.test(p);
}

function segmentGlobToJsRegex(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    if (c === "*") {
      out += "[^/]*";
      i++;
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close === -1) {
        out += escapeRegex(c);
        i++;
        continue;
      }
      out += `[${seg.slice(i + 1, close)}]`;
      i = close + 1;
    } else {
      out += escapeRegex(c);
      i++;
    }
  }
  return out;
}

// -- Public API: SQL builder + JS predicate ---------------------------------

/**
 * Build a SQL fragment that, when ANDed into a `WHERE` clause, removes
 * excluded entries from the result. Returns the fragment plus the params
 * to append (assigned positions starting at `nextParamIdx`).
 *
 * The fragment is `TRUE` (no-op) when no patterns are configured. Otherwise
 * it has the shape `(NOT (lq OR pre OR re))` where each disjunct is omitted
 * if its bucket is empty.
 *
 * `pathExpr` must be the SQL expression naming the ltree path column
 * (e.g. `e.path` or just `path`).
 */
export function excludeWhereSql(
  c: CompiledExcludes,
  pathExpr: string,
  nextParamIdx: number,
): { sql: string; params: SqlParam[] } {
  if (c.empty) return { sql: "TRUE", params: [] };
  const params: SqlParam[] = [];
  const disjuncts: string[] = [];
  let idx = nextParamIdx;

  if (c.lqueries.length > 0) {
    disjuncts.push(`${pathExpr} ~ ANY($${idx}::lquery[])`);
    params.push(c.lqueries);
    idx++;
  }
  if (c.prefixes.length > 0) {
    disjuncts.push(`${pathExpr} <@ ANY($${idx}::ltree[])`);
    params.push(c.prefixes);
    idx++;
  }
  if (c.regexes.length > 0) {
    // Combine into a single regex via alternation to keep param count down.
    const combined = c.regexes.map((r) => `(?:${r})`).join("|");
    disjuncts.push(`${pathExpr}::text ~ $${idx}`);
    params.push(combined);
    idx++;
  }

  return { sql: `NOT (${disjuncts.join(" OR ")})`, params };
}

/**
 * JS-side predicate: returns true when `internalPath` (an internal absolute
 * POSIX path) matches any compiled exclude rule. Used by write-side guards
 * and symlink target resolution where we cannot defer to SQL.
 */
export function isExcluded(c: CompiledExcludes, internalPath: string): boolean {
  if (c.empty) return false;
  const norm = normalizePath(internalPath);
  for (const p of c.rawPatterns) {
    if (p.test(norm)) return true;
  }
  return false;
}
