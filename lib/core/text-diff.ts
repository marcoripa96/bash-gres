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
 * Pairs `[i, j]` of equal lines `a[i] === b[j]` forming a longest common
 * subsequence (Myers' O((N+M)·D) algorithm after trimming the common prefix
 * and suffix), in increasing order of both indices.
 */
export function matchLines(a: string[], b: string[]): Array<[number, number]> {
  // Intern lines so the inner loop compares integers.
  const ids = new Map<string, number>();
  const intern = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const ai = a.map(intern);
  const bi = b.map(intern);

  const pairs: Array<[number, number]> = [];
  let prefix = 0;
  while (prefix < ai.length && prefix < bi.length && ai[prefix] === bi[prefix]) {
    pairs.push([prefix, prefix]);
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < ai.length - prefix &&
    suffix < bi.length - prefix &&
    ai[ai.length - 1 - suffix] === bi[bi.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = ai.slice(prefix, ai.length - suffix);
  const midB = bi.slice(prefix, bi.length - suffix);
  for (const [i, j] of myers(midA, midB)) pairs.push([i + prefix, j + prefix]);
  for (let s = suffix; s > 0; s--) pairs.push([ai.length - s, bi.length - s]);
  return pairs;
}

function myers(a: number[], b: number[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d..d] after step d (index k + d).
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }

  const out: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    const at = (kk: number): number => prev[kk + d - 1]!;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) {
      x--;
      y--;
      out.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push([x, y]);
  }
  out.reverse();
  return out;
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
