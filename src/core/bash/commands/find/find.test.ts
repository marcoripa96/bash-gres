import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";

describe("bash: find", () => {
  const ctx = setupBash("bash-find");

  it("lists all entries recursively from a path", async () => {
    await ctx.fs.mkdir("/project/src", { recursive: true });
    await ctx.fs.writeFile("/project/src/app.ts", "code");
    await ctx.fs.writeFile("/project/readme.md", "doc");
    const r = await ctx.bash.execute("find /project");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/project");
    expect(r.stdout).toContain("/project/src");
    expect(r.stdout).toContain("/project/src/app.ts");
    expect(r.stdout).toContain("/project/readme.md");
  });

  it("uses . as default search path", async () => {
    await ctx.fs.writeFile("/file.txt", "x");
    const r = await ctx.bash.execute("find");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(".");
  });

  describe("-name pattern", () => {
    it("filters by glob pattern", async () => {
      await ctx.fs.mkdir("/project/src", { recursive: true });
      await ctx.fs.writeFile("/project/src/app.ts", "code");
      await ctx.fs.writeFile("/project/src/util.ts", "code");
      await ctx.fs.writeFile("/project/readme.md", "doc");
      const r = await ctx.bash.execute("find /project -name *.ts");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("app.ts");
      expect(r.stdout).toContain("util.ts");
      expect(r.stdout).not.toContain("readme.md");
    });

    it("matches exact name", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/target.txt", "found");
      await ctx.fs.writeFile("/dir/other.txt", "not");
      const r = await ctx.bash.execute("find /dir -name target.txt");
      expect(r.stdout).toContain("target.txt");
      expect(r.stdout).not.toContain("other.txt");
    });

    it("uses ? for single character wildcard", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/a1.txt", "x");
      await ctx.fs.writeFile("/dir/a2.txt", "x");
      await ctx.fs.writeFile("/dir/abc.txt", "x");
      const r = await ctx.bash.execute("find /dir -name a?.txt");
      expect(r.stdout).toContain("a1.txt");
      expect(r.stdout).toContain("a2.txt");
      expect(r.stdout).not.toContain("abc.txt");
    });

    it("returns nothing when no matches", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/file.txt", "x");
      const r = await ctx.bash.execute("find /dir -name *.zzz");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });
  });

  describe("-type filter", () => {
    it("-type f shows only files", async () => {
      await ctx.fs.mkdir("/project/src", { recursive: true });
      await ctx.fs.writeFile("/project/src/app.ts", "code");
      const r = await ctx.bash.execute("find /project -type f");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("app.ts");
      expect(r.stdout).not.toContain("/project/src\n");
    });

    it("-type d shows only directories", async () => {
      await ctx.fs.mkdir("/project/src", { recursive: true });
      await ctx.fs.writeFile("/project/src/app.ts", "code");
      const r = await ctx.bash.execute("find /project -type d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("/project");
      expect(r.stdout).toContain("/project/src");
      expect(r.stdout).not.toContain("app.ts");
    });

    it("-type l shows only symlinks", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/real.txt", "data");
      await ctx.fs.symlink("/dir/real.txt", "/dir/link.txt");
      const r = await ctx.bash.execute("find /dir -type l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("link.txt");
      expect(r.stdout).not.toContain("real.txt");
    });
  });

  describe("combined -name and -type", () => {
    it("filters by both name and type", async () => {
      await ctx.fs.mkdir("/project/src", { recursive: true });
      await ctx.fs.writeFile("/project/src/app.ts", "code");
      await ctx.fs.writeFile("/project/readme.md", "doc");
      const r = await ctx.bash.execute("find /project -type f -name *.ts");
      expect(r.stdout).toContain("app.ts");
      expect(r.stdout).not.toContain("readme.md");
      expect(r.stdout).not.toContain("/project/src\n");
    });
  });

  describe("relative paths", () => {
    it("uses relative paths when starting from .", async () => {
      await ctx.fs.mkdir("/sub");
      await ctx.fs.writeFile("/sub/file.txt", "x");
      await ctx.bash.execute("cd /sub");
      const r = await ctx.bash.execute("find . -name file.txt");
      expect(r.stdout).toContain("./file.txt");
    });

    it("uses absolute paths when starting from absolute path", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/file.txt", "x");
      const r = await ctx.bash.execute("find /dir -name file.txt");
      expect(r.stdout).toContain("/dir/file.txt");
    });
  });
});
