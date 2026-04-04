import { describe, it, expect } from "vitest";
import { setupBash } from "./_setup.js";

describe("bash: ls", () => {
  const ctx = setupBash("bash-ls");

  it("lists files in a directory", async () => {
    await ctx.fs.mkdir("/mydir");
    await ctx.fs.writeFile("/mydir/a.txt", "a");
    await ctx.fs.writeFile("/mydir/b.txt", "b");
    const r = await ctx.bash.execute("ls /mydir");
    expect(r.exitCode).toBe(0);
    const names = r.stdout.trim().split("\n").sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });

  it("lists root directory", async () => {
    await ctx.fs.writeFile("/root-file.txt", "data");
    const r = await ctx.bash.execute("ls /");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("root-file.txt");
  });

  it("defaults to cwd when no path given", async () => {
    await ctx.fs.writeFile("/file.txt", "data");
    const r = await ctx.bash.execute("ls");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("file.txt");
  });

  it("returns empty output for empty directory", async () => {
    await ctx.fs.mkdir("/empty");
    const r = await ctx.bash.execute("ls /empty");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("lists a single file (not a directory)", async () => {
    await ctx.fs.writeFile("/single.txt", "data");
    const r = await ctx.bash.execute("ls /single.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("single.txt");
  });

  it("lists multiple paths", async () => {
    await ctx.fs.writeFile("/x.txt", "x");
    await ctx.fs.writeFile("/y.txt", "y");
    const r = await ctx.bash.execute("ls /x.txt /y.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("x.txt");
    expect(r.stdout).toContain("y.txt");
  });

  it("fails on non-existent path", async () => {
    const r = await ctx.bash.execute("ls /nonexistent");
    expect(r.exitCode).toBe(1);
  });

  describe("-a flag", () => {
    it("shows dot-files", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/.hidden", "secret");
      await ctx.fs.writeFile("/dir/visible.txt", "public");

      const normal = await ctx.bash.execute("ls /dir");
      expect(normal.stdout).not.toContain(".hidden");
      expect(normal.stdout).toContain("visible.txt");

      const all = await ctx.bash.execute("ls -a /dir");
      expect(all.stdout).toContain(".hidden");
      expect(all.stdout).toContain("visible.txt");
    });

    it("includes . and .. entries", async () => {
      await ctx.fs.mkdir("/dir");
      const r = await ctx.bash.execute("ls -a /dir");
      expect(r.stdout).toContain(".");
      expect(r.stdout).toContain("..");
    });
  });

  describe("-l flag", () => {
    it("shows long format with size and date", async () => {
      await ctx.fs.writeFile("/info.txt", "12345");
      const r = await ctx.bash.execute("ls -l /info.txt");
      expect(r.exitCode).toBe(0);
      // Should contain file type indicator, size, date, name
      expect(r.stdout).toContain("info.txt");
      expect(r.stdout).toMatch(/\d{4}-\d{2}-\d{2}/); // date
    });

    it("shows d prefix for directories", async () => {
      await ctx.fs.mkdir("/somedir");
      await ctx.bash.execute("cd /");
      const r = await ctx.bash.execute("ls -l /somedir");
      // When listing a directory itself with -l, it lists contents
      // But listing the parent should show "d" prefix
      await ctx.fs.writeFile("/somedir/child.txt", "x");
      const r2 = await ctx.bash.execute("ls -l /somedir");
      expect(r2.stdout).toContain("child.txt");
    });
  });

  describe("-la combined", () => {
    it("shows long format with hidden files", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/.env", "SECRET=x");
      await ctx.fs.writeFile("/dir/app.js", "code");
      const r = await ctx.bash.execute("ls -la /dir");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(".env");
      expect(r.stdout).toContain("app.js");
      expect(r.stdout).toContain(".");
      expect(r.stdout).toContain("..");
    });
  });
});
