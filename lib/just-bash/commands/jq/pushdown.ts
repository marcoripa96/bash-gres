import type { AggregateKind, Filter } from "./ast.js";

export interface AggregatePlan {
  kind: AggregateKind;
  /** Path components leading to the array (relative to document root). */
  over: string[];
  /**
   * For `sort_by` / `min_by` / `max_by`: the path components inside each
   * array element used to extract the sort key.
   */
  keyPath?: string[];
  /**
   * For string-transform aggregates (`split`, `join`, `ltrimstr`,
   * `rtrimstr`): the literal string argument.
   */
  stringArg?: string;
  /** Second literal argument for regex replacement pushdown. */
  replacementArg?: string;
  /** For `flatten(N)`: the depth limit. Unset means recursive (jq default). */
  depth?: number;
}

/**
 * Recognise filters of shape `<pure-path> | <agg>` where `<agg>` is one of
 * the aggregations Postgres can compute directly:
 *   - zero-arg: length, add, min, max, sort, unique, reverse
 *   - keyed:    sort_by(<path>), min_by(<path>), max_by(<path>)
 * Returns null when the filter doesn't match.
 */
export function planAggregate(ast: Filter): AggregatePlan | null {
  if (ast.type !== "Pipe") return null;
  const over = pureFieldPath(ast.left);
  if (over === null) return null;
  const right = ast.right;
  if (right.type === "Builtin0") {
    const kind = AGG_BUILTIN_TO_KIND[right.name];
    if (kind === undefined) return null;
    return { kind, over };
  }
  if (right.type === "KeyAggregate") {
    const keyPath = pureFieldPath(right.key);
    if (keyPath === null) return null;
    return { kind: right.kind, over, keyPath };
  }
  if (right.type === "StringTransform") {
    return { kind: right.kind, over, stringArg: right.arg };
  }
  if (right.type === "RegexReplace") {
    // PostgreSQL replacement strings interpret backslash escapes. Keep those
    // on the Node path so replacements stay literal for our current subset.
    if (right.replacement.includes("\\")) return null;
    return {
      kind: right.kind,
      over,
      stringArg: right.regex,
      replacementArg: right.replacement,
    };
  }
  if (right.type === "FlattenN") {
    return { kind: "flatten", over, depth: right.depth };
  }
  return null;
}

const AGG_BUILTIN_TO_KIND: Record<string, AggregateKind | undefined> = {
  length: "length",
  add: "sum",
  min: "min",
  max: "max",
  sort: "sort",
  unique: "unique",
  reverse: "reverse",
  to_entries: "to_entries",
  from_entries: "from_entries",
  flatten: "flatten",
  ascii_downcase: "ascii_downcase",
  ascii_upcase: "ascii_upcase",
  tonumber: "tonumber",
};

export interface MapObjectPlan {
  /** Path to the array we'll iterate (empty = document root). */
  over: string[];
  /** Output keys + path components (relative to each element) for values. */
  pairs: Array<{ key: string; valuePath: string[] }>;
}

/**
 * Recognise `<pure-path> | map({k: <path>, ...})` and (also) bare
 * `map({...})`. Each value expression must be a pure path so it maps to
 * `value #> {…}` in SQL. Returns null when the shape doesn't match.
 */
export function planMapObject(ast: Filter): MapObjectPlan | null {
  let over: string[] = [];
  let mapNode: Filter = ast;
  if (ast.type === "Pipe") {
    const lhs = pureFieldPath(ast.left);
    if (lhs === null) return null;
    over = lhs;
    mapNode = ast.right;
  }
  if (mapNode.type !== "Map") return null;
  const body = mapNode.body;
  if (body.type !== "ObjectCons") return null;
  const pairs: MapObjectPlan["pairs"] = [];
  for (const pair of body.pairs) {
    if (typeof pair.key !== "string") return null;
    const valuePath = pureFieldPath(pair.value);
    if (valuePath === null) return null;
    pairs.push({ key: pair.key, valuePath });
  }
  return { over, pairs };
}

export interface SlicePlan {
  /** Path components leading to the array to slice. */
  over: string[];
  /** Inclusive 0-based start, or null for "from beginning". */
  start: number | null;
  /** Exclusive 0-based end, or null for "to end". */
  end: number | null;
}

/**
 * Recognise `<pure-path>[start:end]` (positive bounds only) and return a
 * slice plan. Negative bounds need length-aware SQL — left to Node for now.
 */
export function planSlice(ast: Filter): SlicePlan | null {
  // Bare `.[a:b]` → slice over the document root.
  if (ast.type === "Slice") {
    if (!boundsArePushable(ast.start, ast.end)) return null;
    return { over: [], start: ast.start, end: ast.end };
  }
  if (ast.type !== "Pipe") return null;
  if (ast.right.type !== "Slice") return null;
  const over = pureFieldPath(ast.left);
  if (over === null) return null;
  if (!boundsArePushable(ast.right.start, ast.right.end)) return null;
  return { over, start: ast.right.start, end: ast.right.end };
}

/**
 * Plan a `limit(N; <pure-path>[])` as a streamed slice: fetch the first N
 * elements of an array and emit each as a separate jq output. Returns null
 * if the AST doesn't fit this shape.
 */
export function planLimitedIter(
  ast: Filter,
): { over: string[]; limit: number } | null {
  if (ast.type !== "Limit") return null;
  if (ast.count.type !== "Lit" || typeof ast.count.value !== "number") {
    return null;
  }
  const n = ast.count.value;
  if (!Number.isInteger(n) || n < 0) return null;
  if (ast.body.type === "Iter") return { over: [], limit: n };
  if (
    ast.body.type === "Pipe" &&
    ast.body.right.type === "Iter"
  ) {
    const path = pureFieldPath(ast.body.left);
    if (path === null) return null;
    return { over: path, limit: n };
  }
  return null;
}

function boundsArePushable(
  _start: number | null,
  _end: number | null,
): boolean {
  // Negative bounds are now resolved length-aware in queryJsonSlice's SQL.
  return true;
}

function pureFieldPath(ast: Filter): string[] | null {
  switch (ast.type) {
    case "Identity":
      return [];
    case "Field":
      return [ast.name];
    case "Pipe": {
      const l = pureFieldPath(ast.left);
      if (l === null) return null;
      const r = pureFieldPath(ast.right);
      if (r === null) return null;
      return [...l, ...r];
    }
    default:
      return null;
  }
}

export interface PushdownPlan {
  /** SQL/JSON path expression to evaluate against the file's JSONB content. */
  path: string;
  /**
   * If set, the runner must verify that the value at this path (relative to
   * the document root) is a JSON array before using the pushdown result.
   * Empty array `[]` means "check the document root". When the value isn't
   * an array, the runner falls back to the in-Node evaluator so that jq's
   * insertion-order semantics for object iteration are preserved.
   */
  arrayCheckPath?: string[];
  /**
   * If non-null, the residual filter to apply in Node against each value
   * returned by the pushdown query (partial pushdown). When `rest` is null
   * the pushdown handles the whole filter.
   */
  rest: Filter | null;
  /**
   * True when the pushdown query is "path-single": guaranteed to produce
   * exactly one result per input in jq semantics, so an empty result set
   * must be post-processed to a single `null`. False for queries that
   * legitimately produce 0..N results (Iter, filter expressions).
   */
  pathSingle: boolean;
  /**
   * When true, the entire pushdown result array is emitted as a single jq
   * value (used for `map(...)` which collects iter outputs into one array)
   * rather than streamed element-by-element.
   */
  wrapResult?: boolean;
}

interface WalkState {
  prefix: string;
  iterSeen: boolean;
  /** Captured at the moment the first Iter is encountered. */
  arrayCheckPath: string[] | undefined;
  /**
   * Path components accumulated while we are still walking a pure-path
   * prefix (no Iter yet). Snapshotted into `arrayCheckPath` when Iter is
   * reached. Becomes `undefined` once the prefix is no longer pure path
   * (e.g. after a Select inside an iter, or after Iter itself).
   */
  parentPath: string[] | undefined;
  /** Sticky `wrapResult` flag: once a Map is seen, subsequent path nodes
   *  feed into the wrapped result. Currently we only allow Map to be the
   *  trailing op, so this just tracks whether we've already wrapped. */
  wrapResult: boolean;
}

interface WalkResult {
  state: WalkState;
  rest: Filter | null;
  pathSingle: boolean;
}

/**
 * Plan a Postgres pushdown for the given jq filter AST.
 *
 * Returns the longest pushdownable prefix as a `PushdownPlan`. If the
 * prefix collapses to identity (i.e. nothing useful is being pushed down),
 * returns null and the caller should evaluate the whole filter in Node.
 */
export function planPushdown(ast: Filter): PushdownPlan | null {
  const start: WalkState = {
    prefix: "$",
    iterSeen: false,
    arrayCheckPath: undefined,
    parentPath: [],
    wrapResult: false,
  };
  const r = walk(ast, start);
  // Refuse "trivial" pushdowns where we'd fetch the whole document only
  // to evaluate everything in Node — no benefit over a plain readFile.
  if (r.state.prefix === "$" && r.rest !== null && !r.state.iterSeen) {
    return null;
  }
  const plan: PushdownPlan = {
    path: r.state.prefix,
    arrayCheckPath: r.state.arrayCheckPath,
    rest: r.rest,
    pathSingle: r.pathSingle,
  };
  if (r.state.wrapResult) plan.wrapResult = true;
  return plan;
}

function walk(ast: Filter, s: WalkState): WalkResult {
  switch (ast.type) {
    case "Identity":
      return res(s, null, !s.iterSeen);
    case "Field": {
      const next: WalkState = {
        ...s,
        prefix: `${s.prefix}.${quoteFieldName(ast.name)}`,
        parentPath: s.parentPath ? [...s.parentPath, ast.name] : undefined,
      };
      return res(next, null, !s.iterSeen);
    }
    case "Index": {
      const next: WalkState = {
        ...s,
        prefix: `${s.prefix}[${formatIndex(ast.index)}]`,
        // Index inside a parent-path tracker would need a dynamic index in
        // the SQL `#>` operator (it accepts integer-as-text components),
        // but we keep it simple: numeric components disable parent tracking.
        parentPath: s.parentPath
          ? [...s.parentPath, String(ast.index)]
          : undefined,
      };
      return res(next, null, !s.iterSeen);
    }
    case "Iter": {
      if (s.iterSeen) {
        // Refuse a second iter — correctness gets fragile.
        return res(s, ast, false);
      }
      const next: WalkState = {
        ...s,
        prefix: `${s.prefix}[*]`,
        iterSeen: true,
        arrayCheckPath: s.parentPath ?? [],
        parentPath: undefined,
      };
      return res(next, null, false);
    }
    case "RecDescent": {
      // ".**" descends through every level (including self at the current
      // point). Postgres returns subvalues in its own order — for jq's
      // tree-walk semantics this is "best effort". Since the stream of
      // values is already produced by Postgres, no parent array-check is
      // applicable.
      const next: WalkState = {
        ...s,
        prefix: `${s.prefix}.**`,
        iterSeen: true,
        arrayCheckPath: undefined,
        parentPath: undefined,
      };
      return res(next, null, false);
    }
    case "Pipe": {
      const left = walk(ast.left, s);
      if (left.rest !== null) {
        const rest: Filter = { type: "Pipe", left: left.rest, right: ast.right };
        return { state: left.state, rest, pathSingle: left.pathSingle };
      }
      const right = walk(ast.right, left.state);
      return {
        state: right.state,
        rest: right.rest,
        pathSingle: left.pathSingle && right.pathSingle,
      };
    }
    case "Default": {
      // Partial pushdown: push the lhs path, leave `// rhs` in Node so the
      // residual filter operates on the projected value via Identity.
      const left = walk(ast.left, s);
      if (left.rest === null && left.state.prefix !== s.prefix) {
        const rest: Filter = {
          type: "Default",
          left: { type: "Identity" },
          right: ast.right,
        };
        return { state: left.state, rest, pathSingle: left.pathSingle };
      }
      return res(s, ast, false);
    }
    case "Select": {
      if (!s.iterSeen) return res(s, ast, false);
      const expr = renderCondExpr(ast.cond, "@");
      if (expr === null) return res(s, ast, false);
      const next: WalkState = {
        ...s,
        prefix: `${s.prefix} ? (${expr})`,
        parentPath: undefined,
      };
      return res(next, null, false);
    }
    case "Map": {
      // map(f) ≡ [.[] | f]. Pushdown shape: append `[*]` + body's relative
      // jsonpath, then mark the result for wrap-as-single-array. Only
      // viable when:
      //   - we haven't already entered an iteration context (`map` requires
      //     an array input fetched at the current prefix),
      //   - the body is itself a path that walks down to a translatable
      //     jsonpath suffix.
      if (s.iterSeen || s.wrapResult) return res(s, ast, false);
      const bodyStart: WalkState = {
        prefix: "$",
        iterSeen: false,
        arrayCheckPath: undefined,
        parentPath: [],
        wrapResult: false,
      };
      const body = walk(ast.body, bodyStart);
      if (body.rest !== null) return res(s, ast, false);
      if (body.state.iterSeen) return res(s, ast, false);
      const bodySuffix = body.state.prefix.slice(1); // strip leading "$"
      const next: WalkState = {
        ...s,
        prefix: `${s.prefix}[*]${bodySuffix}`,
        iterSeen: true,
        arrayCheckPath: s.parentPath ?? [],
        parentPath: undefined,
        wrapResult: true,
      };
      return res(next, null, false);
    }
    default:
      return res(s, ast, !s.iterSeen);
  }
}

function res(state: WalkState, rest: Filter | null, pathSingle: boolean): WalkResult {
  return { state, rest, pathSingle };
}

function formatIndex(n: number): string {
  if (n >= 0) return String(n);
  if (n === -1) return "last";
  return `last - ${-n - 1}`;
}

const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteFieldName(name: string): string {
  if (SAFE_FIELD.test(name)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render a Filter as a jsonpath sub-expression for the *value* side of a
 * comparison inside `?(...)`. Returns null if the filter isn't a path or
 * literal.
 */
function renderFilterRef(ast: Filter, root: string): string | null {
  if (ast.type === "Lit") return formatLiteral(ast.value);
  if (
    ast.type === "Identity" ||
    ast.type === "Field" ||
    ast.type === "Index" ||
    ast.type === "Pipe"
  ) {
    return appendSimplePath(ast, root);
  }
  if (ast.type === "Arith") {
    const l = renderFilterRef(ast.left, root);
    const r = renderFilterRef(ast.right, root);
    if (l === null || r === null) return null;
    return `(${l} ${ast.op} ${r})`;
  }
  return null;
}

/**
 * Render a Filter as a jsonpath *boolean predicate* for the body of a
 * `?(...)` clause. Supports comparisons, logical and/or, has(), and bare
 * paths (truthy when value isn't null/false). Returns null when the
 * expression contains anything jsonpath can't express.
 */
function renderCondExpr(ast: Filter, root: string): string | null {
  switch (ast.type) {
    case "Compare": {
      const l = renderFilterRef(ast.left, root);
      const r = renderFilterRef(ast.right, root);
      if (l === null || r === null) return null;
      return `${l} ${ast.op} ${r}`;
    }
    case "Logical": {
      const l = renderCondExpr(ast.left, root);
      const r = renderCondExpr(ast.right, root);
      if (l === null || r === null) return null;
      const op = ast.op === "and" ? "&&" : "||";
      return `(${l}) ${op} (${r})`;
    }
    case "Has": {
      return `exists(${root}.${quoteFieldName(ast.key)})`;
    }
    case "Lit": {
      return formatLiteral(ast.value);
    }
    case "Identity":
    case "Field":
    case "Index":
      return renderTruthyOrPredicate(ast, root);
    case "Pipe":
      return renderPipeCond(ast.left, ast.right, root);
    case "StringPredicate":
      return renderStringPredicate(root, ast.kind, ast.arg);
    default:
      return null;
  }
}

/**
 * Render `<lhs> | <stringPredicate>` (or `<lhs> | <truthy-leaf>`) inside a
 * `?(...)` body. For string predicates we collapse them onto the lhs path.
 * Anything else falls through to a plain truthy check on the lhs *if* the
 * rhs is a path (otherwise null).
 */
function renderPipeCond(
  left: Filter,
  right: Filter,
  root: string,
): string | null {
  if (right.type === "StringPredicate") {
    const path = appendSimplePath(left, root);
    if (path === null) return null;
    return renderStringPredicate(path, right.kind, right.arg);
  }
  // Fall back to a simple truthy check on the entire pipe path.
  const fullPath = appendSimplePath({ type: "Pipe", left, right }, root);
  if (fullPath === null) return null;
  return `${fullPath} != null && ${fullPath} != false`;
}

function renderTruthyOrPredicate(ast: Filter, root: string): string | null {
  const path = appendSimplePath(ast, root);
  if (path === null) return null;
  return `${path} != null && ${path} != false`;
}

function renderStringPredicate(
  pathExpr: string,
  kind: "startswith" | "endswith" | "test",
  arg: string,
): string {
  switch (kind) {
    case "startswith":
      return `${pathExpr} starts with ${formatLiteral(arg)}`;
    case "endswith":
      return `${pathExpr} like_regex ${formatLiteral(`${escapeRegex(arg)}$`)}`;
    case "test":
      return `${pathExpr} like_regex ${formatLiteral(arg)}`;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendSimplePath(ast: Filter, prefix: string): string | null {
  switch (ast.type) {
    case "Identity":
      return prefix;
    case "Field":
      return `${prefix}.${quoteFieldName(ast.name)}`;
    case "Index":
      return `${prefix}[${formatIndex(ast.index)}]`;
    case "Pipe": {
      const l = appendSimplePath(ast.left, prefix);
      if (l === null) return null;
      return appendSimplePath(ast.right, l);
    }
    default:
      return null;
  }
}

function formatLiteral(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Back-compat wrapper kept for the existing pushdown unit tests: returns
 * just the jsonpath when the entire filter pushes down as a path-single
 * query, and null otherwise.
 */
export function translateToJsonPath(ast: Filter): string | null {
  const plan = planPushdown(ast);
  if (plan === null) return null;
  if (plan.rest !== null) return null;
  if (!plan.pathSingle) return null;
  if (plan.arrayCheckPath !== undefined) return null;
  return plan.path;
}
