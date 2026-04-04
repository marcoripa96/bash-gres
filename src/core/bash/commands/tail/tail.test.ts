import { describe, it, expect, vi } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: tail [%s]", (_name, factory) => {
  const ctx = setupBash("bash-tail", factory);

  const tenLines = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
  const twentyLines = Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") + "\n";

  it("shows last 10 lines by default", async () => {
    await ctx.fs.writeFile("/data.txt", twentyLines);
    const r = await ctx.bash.execute("tail /data.txt");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("11");
    expect(lines[9]).toBe("20");
  });

  it("-n N shows last N lines", async () => {
    await ctx.fs.writeFile("/data.txt", "1\n2\n3\n4\n5\n");
    const r = await ctx.bash.execute("tail -n 2 /data.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("4\n5\n");
  });

  it("-n 1 shows just the last line", async () => {
    await ctx.fs.writeFile("/data.txt", "1\n2\n3\n");
    const r = await ctx.bash.execute("tail -n 1 /data.txt");
    expect(r.stdout).toBe("3\n");
  });

  it("-n +N shows from line N onwards (1-based)", async () => {
    await ctx.fs.writeFile("/data.txt", "1\n2\n3\n4\n5\n");
    const r = await ctx.bash.execute("tail -n +3 /data.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3\n4\n5\n");
  });

  it("-n +1 shows everything", async () => {
    await ctx.fs.writeFile("/data.txt", "1\n2\n3\n");
    const r = await ctx.bash.execute("tail -n +1 /data.txt");
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  it("works with piped input", async () => {
    await ctx.fs.writeFile("/data.txt", "a\nb\nc\nd\ne\n");
    const r = await ctx.bash.execute("cat /data.txt | tail -n 2");
    expect(r.stdout).toBe("d\ne\n");
  });

  it("-n 0 returns no lines", async () => {
    await ctx.fs.writeFile("/data.txt", tenLines);
    const r = await ctx.bash.execute("tail -n 0 /data.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("formats multiple files like native tail", async () => {
    await ctx.fs.writeFile("/a.txt", "1\n2\n3\n");
    await ctx.fs.writeFile("/b.txt", "x\ny\n");

    const r = await ctx.bash.execute("tail /a.txt /b.txt");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("==> /a.txt <==\n1\n2\n3\n\n==> /b.txt <==\nx\ny\n");
  });

  it("handles file with fewer lines than default", async () => {
    await ctx.fs.writeFile("/short.txt", "one\ntwo\n");
    const r = await ctx.bash.execute("tail /short.txt");
    expect(r.stdout).toBe("one\ntwo\n");
  });

  it("handles single-line file", async () => {
    await ctx.fs.writeFile("/one.txt", "only\n");
    const r = await ctx.bash.execute("tail -n 5 /one.txt");
    expect(r.stdout).toBe("only\n");
  });

  it("handles file without trailing newline", async () => {
    await ctx.fs.writeFile("/noeol.txt", "line1\nline2");
    const r = await ctx.bash.execute("tail -n 1 /noeol.txt");
    expect(r.stdout).toBe("line2");
  });

  it("uses ranged reads for positive line counts", async () => {
    await ctx.fs.writeFile("/data.txt", twentyLines);
    const statSpy = vi.spyOn(ctx.fs, "stat");
    const readFileSpy = vi.spyOn(ctx.fs, "readFile");

    const r = await ctx.bash.execute("tail -n 2 /data.txt");

    expect(r.exitCode).toBe(0);
    expect(statSpy).toHaveBeenCalledWith("/data.txt");
    expect(readFileSpy).toHaveBeenCalledWith(
      "/data.txt",
      expect.objectContaining({ offset: expect.any(Number), limit: expect.any(Number) }),
    );
  });
});
