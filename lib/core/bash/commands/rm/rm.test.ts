import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: rm [%s]", (_name, factory) => {
  const ctx = setupBash("bash-rm", factory);

  it("removes a file", async () => {
    await ctx.fs.writeFile("/doomed.txt", "bye");
    const r = await ctx.bash.execute("rm /doomed.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/doomed.txt")).toBe(false);
  });

  it("removes multiple files", async () => {
    await ctx.fs.writeFile("/a.txt", "a");
    await ctx.fs.writeFile("/b.txt", "b");
    const r = await ctx.bash.execute("rm /a.txt /b.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/a.txt")).toBe(false);
    expect(await ctx.fs.exists("/b.txt")).toBe(false);
  });

  it("fails on non-existent file without -f", async () => {
    const r = await ctx.bash.execute("rm /ghost.txt");
    expect(r.exitCode).toBe(1);
  });

  it("fails when removing non-empty directory without -r", async () => {
    await ctx.fs.mkdir("/dir");
    await ctx.fs.writeFile("/dir/child.txt", "x");
    const r = await ctx.bash.execute("rm /dir");
    expect(r.exitCode).toBe(1);
  });

  it("fails on missing operand", async () => {
    const r = await ctx.bash.execute("rm");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });

  it("refuses to remove /", async () => {
    const r = await ctx.bash.execute("rm -rf /");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("dangerous");
  });

  describe("-r flag", () => {
    it("removes directory and all contents", async () => {
      await ctx.fs.mkdir("/tree/sub", { recursive: true });
      await ctx.fs.writeFile("/tree/sub/file.txt", "data");
      await ctx.fs.writeFile("/tree/top.txt", "top");
      const r = await ctx.bash.execute("rm -r /tree");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/tree")).toBe(false);
    });

    it("removes deeply nested structures", async () => {
      await ctx.fs.mkdir("/deep/a/b/c", { recursive: true });
      await ctx.fs.writeFile("/deep/a/b/c/leaf.txt", "leaf");
      const r = await ctx.bash.execute("rm -r /deep");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/deep")).toBe(false);
    });

    it("-R also works as recursive flag", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/file.txt", "x");
      const r = await ctx.bash.execute("rm -R /dir");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/dir")).toBe(false);
    });
  });

  describe("-f flag", () => {
    it("ignores non-existent files", async () => {
      const r = await ctx.bash.execute("rm -f /no-such-file.txt");
      expect(r.exitCode).toBe(0);
    });

    it("-rf removes directory tree silently", async () => {
      await ctx.fs.mkdir("/tree/sub", { recursive: true });
      await ctx.fs.writeFile("/tree/sub/file.txt", "data");
      const r = await ctx.bash.execute("rm -rf /tree");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/tree")).toBe(false);
    });
  });
});
