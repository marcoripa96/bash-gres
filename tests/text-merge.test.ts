import { describe, it, expect } from "vitest";
import {
  createUnifiedDiff,
  mergeText,
  textMergeResolver,
  type MergeSide,
} from "../lib/core/index.js";

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

describe("createUnifiedDiff", () => {
  it("returns an empty string for equal sides", () => {
    expect(createUnifiedDiff("a\n", "a\n", { path: "/f" })).toBe("");
  });

  it("formats a git-style hunk with 3 lines of context", () => {
    const before = lines("1", "2", "3", "4", "5", "6", "7", "8", "9");
    const after = lines("1", "2", "3", "4", "five", "6", "7", "8", "9");
    expect(createUnifiedDiff(before, after, { path: "/dir/f.sql" })).toBe(
      [
        "--- a/dir/f.sql",
        "+++ b/dir/f.sql",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
        "",
      ].join("\n"),
    );
  });

  it("splits distant changes into separate hunks and honours context", () => {
    const before = lines(...Array.from({ length: 20 }, (_, i) => `l${i + 1}`));
    const after = before.replace("l2\n", "L2\n").replace("l19\n", "L19\n");
    const patch = createUnifiedDiff(before, after, { path: "/f", context: 1 });
    expect(patch.match(/^@@/gm)).toHaveLength(2);
    expect(patch).toContain("@@ -1,3 +1,3 @@\n l1\n-l2\n+L2\n l3\n");
    expect(patch).toContain("@@ -18,3 +18,3 @@\n l18\n-l19\n+L19\n l20\n");
  });

  it("uses /dev/null for added and removed files", () => {
    expect(createUnifiedDiff(null, "x\n", { path: "/new" })).toBe(
      "--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+x\n",
    );
    expect(createUnifiedDiff("x\ny\n", null, { path: "/old" })).toBe(
      "--- a/old\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
    );
  });

  it("marks a missing final newline", () => {
    expect(createUnifiedDiff("a\nb", "a\nb\n", { path: "/f" })).toBe(
      "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
    );
  });
});

describe("mergeText", () => {
  const base = lines("select", "  a,", "  b,", "  c", "from t", "where x", "order by a");

  it("merges changes to different lines", () => {
    const ours = base.replace("  a,", "  a1,");
    const theirs = base.replace("order by a", "order by c");
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      content: lines("select", "  a1,", "  b,", "  c", "from t", "where x", "order by c"),
    });
  });

  it("takes an identical change once", () => {
    const both = base.replace("from t", "from t2");
    expect(mergeText(base, both, both)).toEqual({ clean: true, content: both });
  });

  it("keeps one-sided insertions and deletions", () => {
    const ours = base.replace("  b,\n", "");
    const theirs = base + "limit 10\n";
    const r = mergeText(base, ours, theirs);
    expect(r).toEqual({
      clean: true,
      content: lines("select", "  a,", "  c", "from t", "where x", "order by a", "limit 10"),
    });
  });

  it("conflicts on overlapping changes, with git-style markers", () => {
    const ours = base.replace("from t", "from ours");
    const theirs = base.replace("from t", "from theirs");
    const r = mergeText(base, ours, theirs);
    expect(r.clean).toBe(false);
    if (r.clean) return;
    expect(r.conflicts).toBe(1);
    expect(r.content).toContain(
      "<<<<<<< ours\nfrom ours\n=======\nfrom theirs\n>>>>>>> theirs\n",
    );
  });

  it("conflicts on adjacent changes, as git does", () => {
    const ours = base.replace("  b,", "  B,");
    const theirs = base.replace("  c", "  C");
    expect(mergeText(base, ours, theirs).clean).toBe(false);
  });

  it("merges changes separated by one unchanged line", () => {
    const ours = base.replace("  a,", "  A,");
    const theirs = base.replace("  c", "  C");
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      content: base.replace("  a,", "  A,").replace("  c", "  C"),
    });
  });

  it("treats a missing final newline as a change to the last line", () => {
    const b = "x\ny\n";
    expect(mergeText(b, "x\ny", "X\ny\n").clean).toBe(false);
    expect(mergeText("a\nx\ny\n", "A\nx\ny\n", "a\nx\ny")).toEqual({
      clean: true,
      content: "A\nx\ny",
    });
  });

  it("uses custom labels", () => {
    const r = mergeText("a\n", "b\n", "c\n", { labels: { ours: "chat", theirs: "main" } });
    expect(r.content).toBe("<<<<<<< chat\nb\n=======\nc\n>>>>>>> main\n");
  });
});

describe("textMergeResolver", () => {
  const side = (content: string | null): MergeSide => ({
    type: "file",
    mode: 0o644,
    size: 0,
    mtime: new Date(0),
    blobHash: null,
    symlinkTarget: null,
    content,
  });

  it("returns the clean merge", () => {
    expect(
      textMergeResolver({
        path: "/q.sql",
        base: side("a\nb\nc\n"),
        ours: side("A\nb\nc\n"),
        theirs: side("a\nb\nC\n"),
      }),
    ).toEqual({ content: "A\nb\nC\n" });
  });

  it("leaves overlapping, add/add, modify/delete and binary conflicts alone", () => {
    const r = (b: MergeSide | null, o: MergeSide | null, t: MergeSide | null) =>
      textMergeResolver({ path: "/f", base: b, ours: o, theirs: t });
    expect(r(side("a\n"), side("b\n"), side("c\n"))).toBeUndefined();
    expect(r(null, side("b\n"), side("c\n"))).toBeUndefined();
    expect(r(side("a\n"), null, side("c\n"))).toBeUndefined();
    expect(r(side("a\n"), side(null), side("c\n"))).toBeUndefined();
  });
});
