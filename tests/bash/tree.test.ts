import { describe, it, expect } from "vitest";
import { setupBash } from "./_setup.js";

describe("bash: tree", () => {
  const ctx = setupBash("bash-tree");

  it("shows directory structure", async () => {
    await ctx.fs.mkdir("/project/src", { recursive: true });
    await ctx.fs.writeFile("/project/src/index.ts", "code");
    await ctx.fs.writeFile("/project/package.json", "{}");
    const r = await ctx.bash.execute("tree /project");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/project");
    expect(r.stdout).toContain("src/");
    expect(r.stdout).toContain("index.ts");
    expect(r.stdout).toContain("package.json");
  });

  it("uses tree connectors", async () => {
    await ctx.fs.mkdir("/dir");
    await ctx.fs.writeFile("/dir/a.txt", "a");
    await ctx.fs.writeFile("/dir/b.txt", "b");
    const r = await ctx.bash.execute("tree /dir");
    // Should use tree-drawing characters
    expect(r.stdout).toMatch(/[├└]/);
    expect(r.stdout).toMatch(/──/);
  });

  it("marks directories with /", async () => {
    await ctx.fs.mkdir("/root/child", { recursive: true });
    const r = await ctx.bash.execute("tree /root");
    expect(r.stdout).toContain("child/");
  });

  it("shows nested structure with proper indentation", async () => {
    await ctx.fs.mkdir("/root/a/b", { recursive: true });
    await ctx.fs.writeFile("/root/a/b/leaf.txt", "x");
    await ctx.fs.writeFile("/root/a/mid.txt", "x");
    const r = await ctx.bash.execute("tree /root");
    expect(r.exitCode).toBe(0);
    // The nested file should be more indented
    const lines = r.stdout.split("\n");
    const midLine = lines.find((l) => l.includes("mid.txt"))!;
    const leafLine = lines.find((l) => l.includes("leaf.txt"))!;
    expect(leafLine.indexOf("leaf.txt")).toBeGreaterThan(
      midLine.indexOf("mid.txt"),
    );
  });

  it("shows symlinks with -> target", async () => {
    await ctx.fs.mkdir("/dir");
    await ctx.fs.writeFile("/dir/real.txt", "data");
    await ctx.fs.symlink("/dir/real.txt", "/dir/link.txt");
    const r = await ctx.bash.execute("tree /dir");
    expect(r.stdout).toContain("link.txt -> ");
  });

  it("handles empty directory", async () => {
    await ctx.fs.mkdir("/empty");
    const r = await ctx.bash.execute("tree /empty");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/empty");
  });

  it("defaults to cwd when no argument", async () => {
    await ctx.fs.writeFile("/file.txt", "x");
    const r = await ctx.bash.execute("tree");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("file.txt");
  });

  it("shows last item with └── connector", async () => {
    await ctx.fs.mkdir("/dir");
    await ctx.fs.writeFile("/dir/only.txt", "x");
    const r = await ctx.bash.execute("tree /dir");
    expect(r.stdout).toContain("└── only.txt");
  });
});
