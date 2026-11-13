import type { MergeConflictInput, MergeResolution } from "./types.js";
import { matchLines, splitLines } from "./text-diff.js";

export interface TextMergeOptions {
  /** Names written after the conflict markers. Default `ours` / `theirs`. */
  labels?: { ours?: string; theirs?: string };
}

export type TextMergeResult =
  | { clean: true; content: string }
  | {
      clean: false;
      /** The merge with git-style `<<<<<<<` / `=======` / `>>>>>>>` blocks at each conflict. */
      content: string;
      /** Number of conflict blocks in `content`. */
      conflicts: number;
    };

/**
 * Line-based three-way merge (diff3, as git does it). Each side is diffed
 * against `base`; base lines kept by both sides anchor the merge, and each
 * region between anchors resolves as:
 *
 * - changed on one side only: that side's lines;
 * - changed identically on both sides: those lines, once;
 * - changed differently on both sides: a conflict.
 *
 * Changes on adjacent lines (no unchanged base line between them) fall in
 * one region and conflict, as in git. Line terminators are part of a line,
 * so a missing final newline is a change like any other.
 */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  opts?: TextMergeOptions,
): TextMergeResult {
  const o = splitLines(base);
  const a = splitLines(ours);
  const b = splitLines(theirs);

  const aOf = new Int32Array(o.length).fill(-1);
  for (const [i, j] of matchLines(o, a)) aOf[i] = j;
  const bOf = new Int32Array(o.length).fill(-1);
  for (const [i, j] of matchLines(o, b)) bOf[i] = j;

  const out: string[] = [];
  let conflicts = 0;
  const labels = {
    ours: opts?.labels?.ours ?? "ours",
    theirs: opts?.labels?.theirs ?? "theirs",
  };

  // Positions just past the last anchor in base / ours / theirs.
  let io = 0;
  let ia = 0;
  let ib = 0;
  const emitRegion = (eo: number, ea: number, eb: number): void => {
    const oc = o.slice(io, eo);
    const ac = a.slice(ia, ea);
    const bc = b.slice(ib, eb);
    if (oc.length === 0 && ac.length === 0 && bc.length === 0) return;
    if (sameLines(ac, oc)) out.push(...bc);
    else if (sameLines(bc, oc)) out.push(...ac);
    else if (sameLines(ac, bc)) out.push(...ac);
    else {
      conflicts++;
      out.push(`<<<<<<< ${labels.ours}\n`, ...terminated(ac));
      out.push("=======\n", ...terminated(bc));
      out.push(`>>>>>>> ${labels.theirs}\n`);
    }
  };

  for (let i = 0; i < o.length; i++) {
    const ja = aOf[i]!;
    const jb = bOf[i]!;
    if (ja < 0 || jb < 0) continue;
    emitRegion(i, ja, jb);
    out.push(o[i]!);
    io = i + 1;
    ia = ja + 1;
    ib = jb + 1;
  }
  emitRegion(o.length, a.length, b.length);

  const content = out.join("");
  return conflicts === 0
    ? { clean: true, content }
    : { clean: false, content, conflicts };
}

function sameLines(x: string[], y: string[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Lines inside a conflict block need a newline before the next marker. */
function terminated(lines: string[]): string[] {
  const last = lines[lines.length - 1];
  if (last === undefined || last.endsWith("\n")) return lines;
  return [...lines.slice(0, -1), `${last}\n`];
}

/**
 * A ready-made `merge()` resolver: settles a conflicting text file with
 * `mergeText` when the line-level changes do not overlap, and leaves every
 * other conflict alone (returns `undefined`): overlapping edits, add/add and
 * modify/delete, and files that are not UTF-8 text.
 *
 * Compose it with a resolver of your own for specific paths:
 *
 * ```ts
 * resolve: (c) => c.path.endsWith(".md") ? myResolve(c) : textMergeResolver(c)
 * ```
 */
export function textMergeResolver(
  input: MergeConflictInput,
): MergeResolution | undefined {
  const { base, ours, theirs } = input;
  if (base === null || ours === null || theirs === null) return undefined;
  if (base.content === null || ours.content === null || theirs.content === null) {
    return undefined;
  }
  const merged = mergeText(base.content, ours.content, theirs.content);
  return merged.clean ? { content: merged.content } : undefined;
}
