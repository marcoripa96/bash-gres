import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: mv [%s]", (_name, factory) => {
  const ctx = setupBash("bash-mv", factory);

  it("renames a file", async () => {
    await ctx.fs.writeFile("/old.txt", "data");
    const r = await ctx.bash.execute("mv /old.txt /new.txt");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/old.txt")).toBe(false);
    expect(await ctx.fs.readFile("/new.txt")).toBe("data");
  });

  it("moves file into existing directory", async () => {
    await ctx.fs.writeFile("/file.txt", "content");
    await ctx.fs.mkdir("/dest");
    const r = await ctx.bash.execute("mv /file.txt /dest");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/file.txt")).toBe(false);
    expect(await ctx.fs.readFile("/dest/file.txt")).toBe("content");
  });

  it("renames a directory", async () => {
    await ctx.fs.mkdir("/olddir");
    await ctx.fs.writeFile("/olddir/child.txt", "x");
    const r = await ctx.bash.execute("mv /olddir /newdir");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/olddir")).toBe(false);
    expect(await ctx.fs.readFile("/newdir/child.txt")).toBe("x");
  });

  it("moves directory into existing directory", async () => {
    await ctx.fs.mkdir("/srcdir");
    await ctx.fs.writeFile("/srcdir/a.txt", "a");
    await ctx.fs.mkdir("/dest");
    const r = await ctx.bash.execute("mv /srcdir /dest");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/srcdir")).toBe(false);
    expect(await ctx.fs.readFile("/dest/srcdir/a.txt")).toBe("a");
  });

  it("preserves nested structure on move", async () => {
    await ctx.fs.mkdir("/project/src", { recursive: true });
    await ctx.fs.writeFile("/project/src/index.ts", "code");
    await ctx.fs.writeFile("/project/package.json", "{}");
    const r = await ctx.bash.execute("mv /project /app");
    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.readFile("/app/src/index.ts")).toBe("code");
    expect(await ctx.fs.readFile("/app/package.json")).toBe("{}");
  });

  it("moves multiple sources into an existing directory", async () => {
    await ctx.fs.writeFile("/a.txt", "a");
    await ctx.fs.writeFile("/b.txt", "b");
    await ctx.fs.mkdir("/dest");

    const r = await ctx.bash.execute("mv /a.txt /b.txt /dest");

    expect(r.exitCode).toBe(0);
    expect(await ctx.fs.exists("/a.txt")).toBe(false);
    expect(await ctx.fs.exists("/b.txt")).toBe(false);
    expect(await ctx.fs.readFile("/dest/a.txt")).toBe("a");
    expect(await ctx.fs.readFile("/dest/b.txt")).toBe("b");
  });

  it("fails when multiple sources target a non-directory", async () => {
    await ctx.fs.writeFile("/a.txt", "a");
    await ctx.fs.writeFile("/b.txt", "b");
    await ctx.fs.writeFile("/target.txt", "c");

    const r = await ctx.bash.execute("mv /a.txt /b.txt /target.txt");

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Not a directory");
  });

  it("fails on missing operand", async () => {
    const r = await ctx.bash.execute("mv /only-one");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });

  it("fails when source does not exist", async () => {
    const r = await ctx.bash.execute("mv /ghost.txt /dest.txt");
    expect(r.exitCode).toBe(1);
  });
});
