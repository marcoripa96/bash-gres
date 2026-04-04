import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: ln & readlink [%s]", (_name, factory) => {
  const ctx = setupBash("bash-ln", factory);

  describe("ln -s (symbolic link)", () => {
    it("creates a symlink", async () => {
      await ctx.fs.writeFile("/target.txt", "data");
      const r = await ctx.bash.execute("ln -s /target.txt /link.txt");
      expect(r.exitCode).toBe(0);
      const stat = await ctx.fs.lstat("/link.txt");
      expect(stat.isSymbolicLink).toBe(true);
    });

    it("symlink points to target", async () => {
      await ctx.fs.writeFile("/target.txt", "content");
      await ctx.bash.execute("ln -s /target.txt /link.txt");
      const target = await ctx.fs.readlink("/link.txt");
      expect(target).toBe("/target.txt");
    });

    it("reading symlink follows to target content", async () => {
      await ctx.fs.writeFile("/target.txt", "hello via symlink");
      await ctx.bash.execute("ln -s /target.txt /link.txt");
      const r = await ctx.bash.execute("cat /link.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("hello via symlink");
    });

    it("can create symlink to non-existent target", async () => {
      const r = await ctx.bash.execute("ln -s /nonexistent /dangling.txt");
      expect(r.exitCode).toBe(0);
      const stat = await ctx.fs.lstat("/dangling.txt");
      expect(stat.isSymbolicLink).toBe(true);
    });

    it("can create symlink to directory", async () => {
      await ctx.fs.mkdir("/realdir");
      await ctx.fs.writeFile("/realdir/file.txt", "data");
      const r = await ctx.bash.execute("ln -s /realdir /linkdir");
      expect(r.exitCode).toBe(0);
    });

    it("preserves and resolves relative symlink targets", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.mkdir("/links");
      await ctx.fs.writeFile("/dir/target.txt", "content");

      const r = await ctx.bash.execute("ln -s ../dir/target.txt /links/link.txt");

      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.readlink("/links/link.txt")).toBe("../dir/target.txt");
      expect(await ctx.fs.readFile("/links/link.txt")).toBe("content");
    });
  });

  describe("ln (hard link)", () => {
    it("creates a hard link to a file", async () => {
      await ctx.fs.writeFile("/original.txt", "data");
      const r = await ctx.bash.execute("ln /original.txt /hardlink.txt");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.readFile("/hardlink.txt")).toBe("data");
    });

    it("hard link is independent copy", async () => {
      await ctx.fs.writeFile("/original.txt", "data");
      await ctx.bash.execute("ln /original.txt /hardlink.txt");
      // Modifying one doesn't affect the other (it's a copy in this implementation)
      expect(await ctx.fs.readFile("/hardlink.txt")).toBe("data");
      expect(await ctx.fs.readFile("/original.txt")).toBe("data");
    });
  });

  describe("ln errors", () => {
    it("fails on missing operand", async () => {
      const r = await ctx.bash.execute("ln /only-one");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("missing operand");
    });

    it("fails on missing operand with -s", async () => {
      const r = await ctx.bash.execute("ln -s /only-one");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("missing operand");
    });
  });

  describe("readlink", () => {
    it("shows symlink target", async () => {
      await ctx.fs.writeFile("/target.txt", "data");
      await ctx.fs.symlink("/target.txt", "/link.txt");
      const r = await ctx.bash.execute("readlink /link.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("/target.txt");
    });

    it("fails on non-symlink", async () => {
      await ctx.fs.writeFile("/regular.txt", "data");
      const r = await ctx.bash.execute("readlink /regular.txt");
      expect(r.exitCode).toBe(1);
    });

    it("fails on missing operand", async () => {
      const r = await ctx.bash.execute("readlink");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("missing operand");
    });

    it("fails on non-existent path", async () => {
      const r = await ctx.bash.execute("readlink /nope");
      expect(r.exitCode).toBe(1);
    });
  });
});
