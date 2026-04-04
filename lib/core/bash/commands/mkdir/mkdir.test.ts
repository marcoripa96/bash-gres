import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: mkdir [%s]", (_name, factory) => {
  const ctx = setupBash("bash-mkdir", factory);

  it("creates a directory", async () => {
    const r = await ctx.bash.execute("mkdir /newdir");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/newdir")).toBe(true);
    const stat = await ctx.fs.stat("/newdir");
    expect(stat.isDirectory).toBe(true);
  });

  it("creates multiple directories", async () => {
    const r = await ctx.bash.execute("mkdir /dir1 /dir2 /dir3");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/dir1")).toBe(true);
    expect(await ctx.fs.exists("/dir2")).toBe(true);
    expect(await ctx.fs.exists("/dir3")).toBe(true);
  });

  it("fails without -p when parent does not exist", async () => {
    const r = await ctx.bash.execute("mkdir /a/b/c");
    expect(r.exitCode).toBe(1);
  });

  it("fails on missing operand", async () => {
    const r = await ctx.bash.execute("mkdir");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });

  it("fails when directory already exists (without -p)", async () => {
    await ctx.fs.mkdir("/existing");
    const r = await ctx.bash.execute("mkdir /existing");
    expect(r.exitCode).toBe(1);
  });

  describe("-p flag", () => {
    it("creates nested directory structure", async () => {
      const r = await ctx.bash.execute("mkdir -p /a/b/c/d");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/a")).toBe(true);
      expect(await ctx.fs.exists("/a/b")).toBe(true);
      expect(await ctx.fs.exists("/a/b/c")).toBe(true);
      expect(await ctx.fs.exists("/a/b/c/d")).toBe(true);
    });

    it("succeeds when directory already exists", async () => {
      await ctx.fs.mkdir("/existing");
      const r = await ctx.bash.execute("mkdir -p /existing");
      expect(r.exitCode).toBe(0);
    });

    it("creates multiple nested paths", async () => {
      const r = await ctx.bash.execute("mkdir -p /x/y /z/w");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/x/y")).toBe(true);
      expect(await ctx.fs.exists("/z/w")).toBe(true);
    });
  });
});
