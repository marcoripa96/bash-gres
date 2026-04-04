import { describe, it, expect } from "vitest";
import { setupBash } from "./_setup.js";

describe("bash: wc", () => {
  const ctx = setupBash("bash-wc");

  it("counts lines, words, and bytes by default", async () => {
    await ctx.fs.writeFile("/text.txt", "hello world\nfoo bar\n");
    const r = await ctx.bash.execute("wc /text.txt");
    expect(r.exitCode).toBe(0);
    // 2 lines, 4 words, 20 bytes
    expect(r.stdout).toContain("2");
    expect(r.stdout).toContain("4");
    expect(r.stdout).toContain("20");
    expect(r.stdout).toContain("/text.txt");
  });

  describe("-l flag", () => {
    it("counts only lines", async () => {
      await ctx.fs.writeFile("/text.txt", "a\nb\nc\n");
      const r = await ctx.bash.execute("wc -l /text.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toMatch(/^3\t/);
    });

    it("counts 0 lines for empty file", async () => {
      await ctx.fs.writeFile("/empty.txt", "");
      const r = await ctx.bash.execute("wc -l /empty.txt");
      expect(r.stdout).toContain("0");
    });

    it("counts content without trailing newline as 1 line", async () => {
      await ctx.fs.writeFile("/noeol.txt", "no newline");
      const r = await ctx.bash.execute("wc -l /noeol.txt");
      expect(r.stdout).toContain("1");
    });
  });

  describe("-w flag", () => {
    it("counts only words", async () => {
      await ctx.fs.writeFile("/text.txt", "one two three\nfour five\n");
      const r = await ctx.bash.execute("wc -w /text.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toMatch(/^5\t/);
    });

    it("handles multiple spaces between words", async () => {
      await ctx.fs.writeFile("/spaced.txt", "a   b   c\n");
      const r = await ctx.bash.execute("wc -w /spaced.txt");
      expect(r.stdout).toContain("3");
    });
  });

  describe("-c flag", () => {
    it("counts only bytes", async () => {
      await ctx.fs.writeFile("/text.txt", "hello");
      const r = await ctx.bash.execute("wc -c /text.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("5");
    });
  });

  describe("multiple files", () => {
    it("shows per-file counts and total", async () => {
      await ctx.fs.writeFile("/a.txt", "one\n");
      await ctx.fs.writeFile("/b.txt", "two\nthree\n");
      const r = await ctx.bash.execute("wc -l /a.txt /b.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("/a.txt");
      expect(r.stdout).toContain("/b.txt");
      expect(r.stdout).toContain("total");
    });
  });

  describe("piped input", () => {
    it("counts piped input", async () => {
      await ctx.fs.writeFile("/data.txt", "hello world\nsecond line\n");
      const r = await ctx.bash.execute("cat /data.txt | wc -l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("2");
    });

    it("counts words from piped input", async () => {
      await ctx.fs.writeFile("/data.txt", "a b c\n");
      const r = await ctx.bash.execute("cat /data.txt | wc -w");
      expect(r.stdout.trim()).toBe("3");
    });
  });
});
