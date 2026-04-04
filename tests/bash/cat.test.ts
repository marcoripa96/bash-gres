import { describe, it, expect } from "vitest";
import { setupBash } from "./_setup.js";

describe("bash: cat", () => {
  const ctx = setupBash("bash-cat");

  it("reads a single file", async () => {
    await ctx.fs.writeFile("/hello.txt", "hello world");
    const r = await ctx.bash.execute("cat /hello.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello world");
  });

  it("reads multiple files concatenated", async () => {
    await ctx.fs.writeFile("/a.txt", "aaa\n");
    await ctx.fs.writeFile("/b.txt", "bbb\n");
    const r = await ctx.bash.execute("cat /a.txt /b.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("aaa\nbbb\n");
  });

  it("reads from piped input when no args", async () => {
    await ctx.fs.writeFile("/src.txt", "piped data");
    const r = await ctx.bash.execute("echo piped data | cat");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("piped data");
  });

  it("reads stdin via - argument", async () => {
    await ctx.fs.writeFile("/file.txt", "file content");
    // When piped, cat - reads from stdin
    const r = await ctx.bash.execute("echo stdin | cat -");
    expect(r.stdout).toContain("stdin");
  });

  it("preserves file content exactly", async () => {
    const content = "line1\nline2\n\n  indented\n";
    await ctx.fs.writeFile("/exact.txt", content);
    const r = await ctx.bash.execute("cat /exact.txt");
    expect(r.stdout).toBe(content);
  });

  it("reads empty file", async () => {
    await ctx.fs.writeFile("/empty.txt", "");
    const r = await ctx.bash.execute("cat /empty.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails on non-existent file", async () => {
    const r = await ctx.bash.execute("cat /nope.txt");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBeTruthy();
  });

  it("fails with no args and no piped input", async () => {
    const r = await ctx.bash.execute("cat");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing operand");
  });

  it("reports errors but still outputs valid files", async () => {
    await ctx.fs.writeFile("/good.txt", "good\n");
    const r = await ctx.bash.execute("cat /good.txt /missing.txt");
    // Should still output the good file
    expect(r.stdout).toContain("good");
    // But report the error
    expect(r.exitCode).toBe(1);
  });

  it("works with redirect to write to file", async () => {
    await ctx.fs.writeFile("/src.txt", "source data");
    await ctx.bash.execute("cat /src.txt > /dest.txt");
    expect(await ctx.fs.readFile("/dest.txt")).toBe("source data");
  });
});
