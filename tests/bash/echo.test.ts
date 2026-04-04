import { describe, it, expect } from "vitest";
import { setupBash } from "./_setup.js";

describe("bash: echo", () => {
  const ctx = setupBash("bash-echo");

  it("outputs text with trailing newline", async () => {
    const r = await ctx.bash.execute("echo hello");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello\n");
  });

  it("joins multiple arguments with spaces", async () => {
    const r = await ctx.bash.execute("echo one two three");
    expect(r.stdout).toBe("one two three\n");
  });

  it("outputs just a newline when no args", async () => {
    const r = await ctx.bash.execute("echo");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("\n");
  });

  it("preserves quoted strings with spaces", async () => {
    const r = await ctx.bash.execute('echo "hello world"');
    expect(r.stdout).toBe("hello world\n");
  });

  it("handles single-quoted strings", async () => {
    const r = await ctx.bash.execute("echo 'hello world'");
    expect(r.stdout).toBe("hello world\n");
  });

  describe("-n flag", () => {
    it("suppresses trailing newline", async () => {
      const r = await ctx.bash.execute("echo -n hello");
      expect(r.stdout).toBe("hello");
    });

    it("outputs nothing for empty -n", async () => {
      const r = await ctx.bash.execute("echo -n");
      expect(r.stdout).toBe("");
    });
  });

  describe("-e flag", () => {
    it("interprets \\n as newline", async () => {
      const r = await ctx.bash.execute('echo -e "line1\\nline2"');
      expect(r.stdout).toBe("line1\nline2\n");
    });

    it("interprets \\t as tab", async () => {
      const r = await ctx.bash.execute('echo -e "col1\\tcol2"');
      expect(r.stdout).toBe("col1\tcol2\n");
    });

    it("interprets \\r as carriage return", async () => {
      const r = await ctx.bash.execute('echo -e "hello\\rworld"');
      expect(r.stdout).toBe("hello\rworld\n");
    });

    it("interprets \\\\ as literal backslash", async () => {
      const r = await ctx.bash.execute('echo -e "back\\\\slash"');
      expect(r.stdout).toBe("back\\slash\n");
    });
  });

  describe("combined flags", () => {
    it("-ne suppresses newline and interprets escapes", async () => {
      const r = await ctx.bash.execute('echo -ne "a\\nb"');
      expect(r.stdout).toBe("a\nb");
    });

    it("-en also works", async () => {
      const r = await ctx.bash.execute('echo -en "x\\ty"');
      expect(r.stdout).toBe("x\ty");
    });
  });

  describe("with redirect", () => {
    it("writes to file via >", async () => {
      const r = await ctx.bash.execute('echo "content" > /file.txt');
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.readFile("/file.txt")).toBe("content\n");
    });

    it("appends to file via >>", async () => {
      await ctx.bash.execute('echo "first" > /file.txt');
      await ctx.bash.execute('echo "second" >> /file.txt');
      expect(await ctx.fs.readFile("/file.txt")).toBe("first\nsecond\n");
    });
  });
});
