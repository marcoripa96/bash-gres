/**
 * Line-level text diffing shared by `createUnifiedDiff` (patches for diff
 * results and UIs) and `mergeText` (three-way merge). Pure functions, no
 * database access.
 *
 * Lines keep their terminator (`"a\n"`), so a last line without a newline
 * differs from the same line with one, as in git.
 */

/** Split text into lines, each keeping its trailing `\n` (the last may lack one). */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
}

/**
 * Work budget for one `matchLines` call, in diagonal steps of the Myers
 * search (roughly 30 ms of CPU per million). Edits of up to about 2,000
 * changed lines stay exact. Past it the remaining unmatched
 * ranges count as wholly replaced: a diff shows them removed and added, a
 * merge treats them as changed (more conflicts, never a wrong merge). Keeps
 * a pathological pair (two large, entirely different files) bounded in time;
 * memory is linear in the line count regardless.
 */
const MATCH_BUDGET = 5_000_000;

/**
 * Pairs `[i, j]` of equal lines `a[i] === b[j]` forming a common
 * subsequence, in increasing order of both indices: a longest one (Myers'
 * O((N+M)·D) algorithm, linear-space bisection form, after trimming the
 * common prefix and suffix) unless the work budget runs out first.
 */
export function matchLines(a: string[], b: string[]): Array<[number, number]> {
  // Intern lines so the inner loops compare integers.
  const ids = new Map<string, number>();
  const intern = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const pairs: Array<[number, number]> = [];
  matchRange(
    { a: a.map(intern), b: b.map(intern), budget: MATCH_BUDGET },
    0,
    a.length,
    0,
    b.length,
    pairs,
  );
  return pairs;
}

interface MatchState {
  a: number[];
  b: number[];
  budget: number;
}

/** Append the matches of `a[aLo..aHi)` against `b[bLo..bHi)` to `out`, in order. */
function matchRange(
  st: MatchState,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  out: Array<[number, number]>,
): void {
  const { a, b } = st;
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push([aLo++, bLo++]);
  let tail = 0;
  while (aLo < aHi - tail && bLo < bHi - tail && a[aHi - 1 - tail] === b[bHi - 1 - tail]) {
    tail++;
  }
  aHi -= tail;
  bHi -= tail;
  if (aLo < aHi && bLo < bHi) {
    const split = bisect(st, aLo, aHi, bLo, bHi);
    // No split: nothing in common, or the budget ran out (wholly replaced).
    if (split !== null) {
      matchRange(st, aLo, split[0], bLo, split[1], out);
      matchRange(st, split[0], aHi, split[1], bHi, out);
    }
  }
  for (let t = 0; t < tail; t++) out.push([aHi + t, bHi + t]);
}

/**
 * Find a point on an optimal edit path through the range by running the
 * Myers search from both ends until the paths meet (the "middle snake"), in
 * O(N+M) memory. Returns absolute `[x, y]` strictly inside the range (both
 * halves smaller than the whole), or `null` when the sides share nothing or
 * the budget runs out. The range must not start or end with equal lines.
 */
function bisect(
  st: MatchState,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): [number, number] | null {
  const { a, b } = st;
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD;
  // v1: furthest x per diagonal from the start; v2: the same from the end,
  // in reversed coordinates. -1 = not reached yet.
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  // Diagonals that ran off the grid are trimmed from later steps.
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  const split = (x: number, y: number): [number, number] | null =>
    (x === 0 && y === 0) || (x === n && y === m) ? null : [aLo + x, bLo + y];

  for (let d = 0; d < maxD; d++) {
    st.budget -= 2 * d + 1;
    if (st.budget < 0) return null;
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 =
        k1 === -d || (k1 !== d && v1[k1o - 1]! < v1[k1o + 1]!)
          ? v1[k1o + 1]!
          : v1[k1o - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1 && x1 >= n - v2[k2o]!) {
          return split(x1, y1);
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 =
        k2 === -d || (k2 !== d && v2[k2o - 1]! < v2[k2o + 1]!)
          ? v2[k2o + 1]!
          : v2[k2o - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o]!;
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return split(x1, y1);
        }
      }
    }
  }
  return null;
}

type Op = { kind: " " | "-" | "+"; line: string; oldNo: number; newNo: number };

function editScript(a: string[], b: string[]): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  const flush = (toI: number, toJ: number): void => {
    while (i < toI) ops.push({ kind: "-", line: a[i]!, oldNo: i++, newNo: j });
    while (j < toJ) ops.push({ kind: "+", line: b[j]!, oldNo: i, newNo: j++ });
  };
  for (const [mi, mj] of matchLines(a, b)) {
    flush(mi, mj);
    ops.push({ kind: " ", line: a[i]!, oldNo: i++, newNo: j++ });
  }
  flush(a.length, b.length);
  return ops;
}

export interface UnifiedDiffOptions {
  /** Path shown in the `--- a/…` / `+++ b/…` headers. */
  path: string;
  /** Unchanged lines around each change. Default 3, as in git. */
  context?: number;
}

/**
 * A git-style unified diff of one file: `--- a/path` / `+++ b/path` headers
 * (`/dev/null` for a side that is `null`, i.e. an added or removed file),
 * `@@ -l,s +l,s @@` hunks, and `\ No newline at end of file` markers.
 * Returns `""` when both sides are equal.
 */
export function createUnifiedDiff(
  before: string | null,
  after: string | null,
  opts: UnifiedDiffOptions,
): string {
  if (before === after) return "";
  const context = Math.max(0, Math.floor(opts.context ?? 3));
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const ops = editScript(a, b);
  const rel = opts.path.replace(/^\/+/, "");
  const header =
    `--- ${before === null ? "/dev/null" : `a/${rel}`}\n` +
    `+++ ${after === null ? "/dev/null" : `b/${rel}`}\n`;

  const changed: number[] = [];
  ops.forEach((op, idx) => {
    if (op.kind !== " ") changed.push(idx);
  });
  if (changed.length === 0) return "";

  // Group change indices into hunks whose context windows touch or overlap.
  const hunks: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length - 1, changed[0]! + context);
  for (const idx of changed.slice(1)) {
    if (idx - context <= end + 1) {
      end = Math.min(ops.length - 1, idx + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  hunks.push([start, end]);

  let out = header;
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const oldLen = slice.filter((op) => op.kind !== "+").length;
    const newLen = slice.filter((op) => op.kind !== "-").length;
    const first = slice[0]!;
    out += `@@ -${range(first.oldNo, oldLen)} +${range(first.newNo, newLen)} @@\n`;
    for (const op of slice) {
      if (op.line.endsWith("\n")) {
        out += op.kind + op.line;
      } else {
        out += `${op.kind}${op.line}\n\\ No newline at end of file\n`;
      }
    }
  }
  return out;
}

/** `start,len` in unified-diff form: 1-based, `,1` omitted, empty ranges point at the line before. */
function range(zeroBasedStart: number, len: number): string {
  const start = len === 0 ? zeroBasedStart : zeroBasedStart + 1;
  return len === 1 ? `${start}` : `${start},${len}`;
}
