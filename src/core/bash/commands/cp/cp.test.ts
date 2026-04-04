import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";

describe("bash: cp", () => {
  const ctx = setupBash("bash-cp");

  it("copies a file", async () => {
    await ctx.fs.writeFile("/src.txt", "data");
    const r = await ctx.bash.execute("cp /src.txt /dst.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.readFile("/dst.txt")).toBe("data");
    // source still exists
    expect(await ctx.fs.readFile("/src.txt")).toBe("data");
  });

  it("overwrites existing destination file", async () => {
    await ctx.fs.writeFile("/src.txt", "new");
    await ctx.fs.writeFile("/dst.txt", "old");
    const r = await ctx.bash.execute("cp /src.txt /dst.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.readFile("/dst.txt")).toBe("new");
  });

  it("copies file into existing directory", async () => {
    await ctx.fs.writeFile("/file.txt", "content");
    await ctx.fs.mkdir("/dest");
    const r = await ctx.bash.execute("cp /file.txt /dest");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.readFile("/dest/file.txt")).toBe("content");
  });

  it("copies multiple sources into an existing directory", async () => {
    await ctx.fs.writeFile("/a.txt", "a");
    await ctx.fs.writeFile("/b.txt", "b");
    await ctx.fs.mkdir("/dest");

    const r = await ctx.bash.execute("cp /a.txt /b.txt /dest");

    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.readFile("/dest/a.txt")).toBe("a");
    expect(await ctx.fs.readFile("/dest/b.txt")).toBe("b");
  });

  it("fails when multiple sources target a non-directory", async () => {
    await ctx.fs.writeFile("/a.txt", "a");
    await ctx.fs.writeFile("/b.txt", "b");
    await ctx.fs.writeFile("/target.txt", "c");

    const r = await ctx.bash.execute("cp /a.txt /b.txt /target.txt");

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Not a directory");
  });

  it("fails on missing operand", async () => {
    const r = await ctx.bash.execute("cp /only-one");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });

  it("fails copying directory without -r", async () => {
    await ctx.fs.mkdir("/srcdir");
    await ctx.fs.writeFile("/srcdir/file.txt", "x");
    const r = await ctx.bash.execute("cp /srcdir /dstdir");
    expect(r.exitCode).toBe(1);
  });

  describe("-r flag", () => {
    it("copies directory recursively", async () => {
      await ctx.fs.mkdir("/src/sub", { recursive: true });
      await ctx.fs.writeFile("/src/a.txt", "aaa");
      await ctx.fs.writeFile("/src/sub/b.txt", "bbb");
      const r = await ctx.bash.execute("cp -r /src /dst");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.readFile("/dst/a.txt")).toBe("aaa");
      expect(await ctx.fs.readFile("/dst/sub/b.txt")).toBe("bbb");
    });

    it("-R also works", async () => {
      await ctx.fs.mkdir("/srcdir");
      await ctx.fs.writeFile("/srcdir/file.txt", "data");
      const r = await ctx.bash.execute("cp -R /srcdir /dstdir");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.readFile("/dstdir/file.txt")).toBe("data");
    });

    it("copies directory into existing directory", async () => {
      await ctx.fs.mkdir("/src");
      await ctx.fs.writeFile("/src/file.txt", "hello");
      await ctx.fs.mkdir("/existing");
      const r = await ctx.bash.execute("cp -r /src /existing");
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.readFile("/existing/src/file.txt")).toBe("hello");
    });
  });
});
