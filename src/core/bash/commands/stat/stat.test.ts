import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";

describe("bash: stat", () => {
  const ctx = setupBash("bash-stat");

  it("shows file info", async () => {
    await ctx.fs.writeFile("/file.txt", "hello world");
    const r = await ctx.bash.execute("stat /file.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("File: /file.txt");
    expect(r.stdout).toContain("regular file");
  });

  it("shows directory info", async () => {
    await ctx.fs.mkdir("/mydir");
    const r = await ctx.bash.execute("stat /mydir");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("File: /mydir");
    expect(r.stdout).toContain("directory");
  });

  it("shows file size", async () => {
    await ctx.fs.writeFile("/sized.txt", "12345");
    const r = await ctx.bash.execute("stat /sized.txt");
    expect(r.stdout).toContain("Size: 5");
  });

  it("shows mode in octal", async () => {
    await ctx.fs.writeFile("/file.txt", "data");
    await ctx.fs.chmod("/file.txt", 0o755);
    const r = await ctx.bash.execute("stat /file.txt");
    expect(r.stdout).toContain("Mode: 0755");
  });

  it("shows modification time in ISO format", async () => {
    await ctx.fs.writeFile("/file.txt", "data");
    const r = await ctx.bash.execute("stat /file.txt");
    expect(r.stdout).toMatch(/Modify: \d{4}-\d{2}-\d{2}T/);
  });

  it("fails on missing operand", async () => {
    const r = await ctx.bash.execute("stat");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });

  it("fails on non-existent path", async () => {
    const r = await ctx.bash.execute("stat /nope");
    expect(r.exitCode).toBe(1);
  });
});
