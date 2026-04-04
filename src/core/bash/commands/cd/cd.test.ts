import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: cd & pwd [%s]", (_name, factory) => {
  const ctx = setupBash("bash-cd", factory);

  describe("pwd", () => {
    it("starts at root", async () => {
      const r = await ctx.bash.execute("pwd");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("/");
    });
  });

  describe("cd", () => {
    it("changes to a directory", async () => {
      await ctx.fs.mkdir("/mydir");
      await ctx.bash.execute("cd /mydir");
      const r = await ctx.bash.execute("pwd");
      expect(r.stdout.trim()).toBe("/mydir");
    });

    it("changes to nested directory", async () => {
      await ctx.fs.mkdir("/a/b/c", { recursive: true });
      await ctx.bash.execute("cd /a/b/c");
      const r = await ctx.bash.execute("pwd");
      expect(r.stdout.trim()).toBe("/a/b/c");
    });

    it("returns to root with no args", async () => {
      await ctx.fs.mkdir("/somewhere");
      await ctx.bash.execute("cd /somewhere");
      await ctx.bash.execute("cd");
      const r = await ctx.bash.execute("pwd");
      expect(r.stdout.trim()).toBe("/");
    });

    it("fails on non-existent directory", async () => {
      const r = await ctx.bash.execute("cd /nonexistent");
      expect(r.exitCode).toBe(1);
    });

    it("fails when target is a file", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      const r = await ctx.bash.execute("cd /file.txt");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Not a directory");
    });

    it("supports relative paths", async () => {
      await ctx.fs.mkdir("/a/b", { recursive: true });
      await ctx.bash.execute("cd /a");
      await ctx.bash.execute("cd b");
      const r = await ctx.bash.execute("pwd");
      expect(r.stdout.trim()).toBe("/a/b");
    });

    it("affects subsequent commands", async () => {
      await ctx.fs.mkdir("/workdir");
      await ctx.fs.writeFile("/workdir/data.txt", "hello");
      await ctx.bash.execute("cd /workdir");
      const r = await ctx.bash.execute("cat data.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("hello");
    });

    it("ls uses cwd after cd", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/file.txt", "x");
      await ctx.bash.execute("cd /dir");
      const r = await ctx.bash.execute("ls");
      expect(r.stdout).toContain("file.txt");
    });
  });
});
