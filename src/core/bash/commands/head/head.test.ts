import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";

describe("bash: head", () => {
  const ctx = setupBash("bash-head");

  const tenLines = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
  const twentyLines = Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") + "\n";

  it("shows first 10 lines by default", async () => {
    await ctx.fs.writeFile("/data.txt", twentyLines);
    const r = await ctx.bash.execute("head /data.txt");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("1");
    expect(lines[9]).toBe("10");
  });

  it("-n N shows first N lines", async () => {
    await ctx.fs.writeFile("/data.txt", tenLines);
    const r = await ctx.bash.execute("head -n 3 /data.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  it("-n 1 shows just the first line", async () => {
    await ctx.fs.writeFile("/data.txt", tenLines);
    const r = await ctx.bash.execute("head -n 1 /data.txt");
    expect(r.stdout).toBe("1\n");
  });

  it("-n -N shows all except last N lines", async () => {
    await ctx.fs.writeFile("/data.txt", "1\n2\n3\n4\n5\n");
    const r = await ctx.bash.execute("head -n -2 /data.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  it("-n -N with N >= total lines returns empty", async () => {
    await ctx.fs.writeFile("/data.txt", "1\n2\n");
    const r = await ctx.bash.execute("head -n -5 /data.txt");
    expect(r.stdout).toBe("");
  });

  it("works with piped input", async () => {
    await ctx.fs.writeFile("/data.txt", "a\nb\nc\nd\ne\n");
    const r = await ctx.bash.execute("cat /data.txt | head -n 2");
    expect(r.stdout).toBe("a\nb\n");
  });

  it("handles file with fewer lines than default", async () => {
    await ctx.fs.writeFile("/short.txt", "one\ntwo\n");
    const r = await ctx.bash.execute("head /short.txt");
    expect(r.stdout).toBe("one\ntwo\n");
  });

  it("handles single-line file", async () => {
    await ctx.fs.writeFile("/one.txt", "only line\n");
    const r = await ctx.bash.execute("head -n 5 /one.txt");
    expect(r.stdout).toBe("only line\n");
  });

  it("handles file without trailing newline", async () => {
    await ctx.fs.writeFile("/noeol.txt", "line1\nline2");
    const r = await ctx.bash.execute("head -n 1 /noeol.txt");
    expect(r.stdout).toBe("line1\n");
  });
});
