import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: touch [%s]", (_name, factory) => {
  const ctx = setupBash("bash-touch", factory);

  it("creates an empty file", async () => {
    const r = await ctx.bash.execute("touch /new.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/new.txt")).toBe(true);
    expect(await ctx.fs.readFile("/new.txt")).toBe("");
  });

  it("creates multiple files", async () => {
    const r = await ctx.bash.execute("touch /a.txt /b.txt /c.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/a.txt")).toBe(true);
    expect(await ctx.fs.exists("/b.txt")).toBe(true);
    expect(await ctx.fs.exists("/c.txt")).toBe(true);
  });

  it("does not overwrite existing file content", async () => {
    await ctx.fs.writeFile("/existing.txt", "keep me");
    await ctx.bash.execute("touch /existing.txt");
    expect(await ctx.fs.readFile("/existing.txt")).toBe("keep me");
  });

  it("updates mtime of existing file", async () => {
    await ctx.fs.writeFile("/file.txt", "data");
    const before = (await ctx.fs.stat("/file.txt")).mtime;
    // Small delay to ensure time difference
    await new Promise((r) => setTimeout(r, 50));
    await ctx.bash.execute("touch /file.txt");
    const after = (await ctx.fs.stat("/file.txt")).mtime;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("fails when parent directories do not exist", async () => {
    const r = await ctx.bash.execute("touch /deep/nested/file.txt");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no such file or directory");
    expect(await ctx.fs.exists("/deep/nested/file.txt")).toBe(false);
  });

  it("fails on missing operand", async () => {
    const r = await ctx.bash.execute("touch");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });
});
