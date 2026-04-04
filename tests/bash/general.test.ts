import { describe, it, expect, vi } from "vitest";
import { setupBash } from "./_setup.js";
import { TEST_ADAPTERS } from "../helpers.js";

describe.each(TEST_ADAPTERS)("bash: general [%s]", (_name, factory) => {
  const ctx = setupBash("bash-general", factory);

  // -- Pipes ------------------------------------------------------------------

  describe("pipes", () => {
    it("pipes stdout of one command to stdin of next", async () => {
      await ctx.fs.writeFile("/data.txt", "alpha\nbeta\ngamma\ndelta\n");
      const r = await ctx.bash.execute("cat /data.txt | head -n 2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("alpha\nbeta\n");
    });

    it("supports multi-stage pipe chains", async () => {
      await ctx.fs.writeFile("/nums.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
      const r = await ctx.bash.execute("cat /nums.txt | head -n 5 | tail -n 2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("4\n5\n");
    });

    it("pipe into grep filters lines", async () => {
      await ctx.fs.writeFile("/log.txt", "INFO start\nERROR fail\nINFO end\n");
      const r = await ctx.bash.execute("cat /log.txt | grep ERROR");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("ERROR fail\n");
    });

    it("pipe into wc counts piped input", async () => {
      await ctx.fs.writeFile("/words.txt", "hello world\nfoo bar baz\n");
      const r = await ctx.bash.execute("cat /words.txt | wc -l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("2");
    });

    it("pipe failure stops the chain", async () => {
      const r = await ctx.bash.execute("cat /nonexistent.txt | head -n 1");
      expect(r.exitCode).not.toBe(0);
    });
  });

  // -- Redirects --------------------------------------------------------------

  describe("redirects", () => {
    it("> creates file with command output", async () => {
      await ctx.bash.execute('echo "hello" > /out.txt');
      expect(await ctx.fs.readFile("/out.txt")).toBe("hello\n");
    });

    it("> truncates existing file", async () => {
      await ctx.fs.writeFile("/out.txt", "old content");
      await ctx.bash.execute('echo "new" > /out.txt');
      expect(await ctx.fs.readFile("/out.txt")).toBe("new\n");
    });

    it(">> appends to existing file", async () => {
      await ctx.bash.execute('echo "line1" > /log.txt');
      await ctx.bash.execute('echo "line2" >> /log.txt');
      expect(await ctx.fs.readFile("/log.txt")).toBe("line1\nline2\n");
    });

    it(">> creates file if it does not exist", async () => {
      await ctx.bash.execute('echo "first" >> /new.txt');
      expect(await ctx.fs.readFile("/new.txt")).toBe("first\n");
    });

    it("redirect creates parent directories", async () => {
      await ctx.bash.execute('echo "deep" > /a/b/c/file.txt');
      expect(await ctx.fs.readFile("/a/b/c/file.txt")).toBe("deep\n");
    });

    it("redirect suppresses stdout", async () => {
      const r = await ctx.bash.execute('echo "hidden" > /out.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  // -- Compound operators -----------------------------------------------------

  describe("&& operator", () => {
    it("runs second command when first succeeds", async () => {
      await ctx.bash.execute("mkdir /testdir");
      const r = await ctx.bash.execute(
        'echo "ok" > /testdir/a.txt && echo "done" > /testdir/b.txt',
      );
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/testdir/b.txt")).toBe(true);
    });

    it("skips second command when first fails", async () => {
      const r = await ctx.bash.execute(
        'cat /nonexistent && echo "should not run" > /flag.txt',
      );
      expect(r.exitCode).not.toBe(0);
      expect(await ctx.fs.exists("/flag.txt")).toBe(false);
    });
  });

  describe("|| operator", () => {
    it("runs second command when first fails", async () => {
      const r = await ctx.bash.execute(
        'cat /nonexistent || echo "fallback" > /flag.txt',
      );
      expect(await ctx.fs.readFile("/flag.txt")).toBe("fallback\n");
    });

    it("skips second command when first succeeds", async () => {
      await ctx.fs.writeFile("/exists.txt", "hi");
      const r = await ctx.bash.execute(
        'cat /exists.txt || echo "nope" > /flag.txt',
      );
      expect(r.exitCode).toBe(0);
      expect(await ctx.fs.exists("/flag.txt")).toBe(false);
    });
  });

  describe("; operator", () => {
    it("runs commands sequentially regardless of exit code", async () => {
      await ctx.bash.execute(
        'echo "a" > /a.txt; echo "b" > /b.txt',
      );
      expect(await ctx.fs.readFile("/a.txt")).toBe("a\n");
      expect(await ctx.fs.readFile("/b.txt")).toBe("b\n");
    });
  });

  // -- Unknown / empty --------------------------------------------------------

  describe("unknown command", () => {
    it("returns exit code 1 and command not found", async () => {
      const r = await ctx.bash.execute("nonexistent");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("command not found");
    });

    it("includes the command name in the error", async () => {
      const r = await ctx.bash.execute("foobar --help");
      expect(r.stderr).toContain("foobar");
    });
  });

  describe("empty input", () => {
    it("returns success for empty string", async () => {
      const r = await ctx.bash.execute("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("returns success for whitespace-only string", async () => {
      const r = await ctx.bash.execute("   ");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  // -- Glob expansion ---------------------------------------------------------

  describe("glob expansion", () => {
    it("expands * in arguments", async () => {
      await ctx.fs.writeFile("/a.txt", "aaa");
      await ctx.fs.writeFile("/b.txt", "bbb");
      await ctx.fs.writeFile("/c.log", "ccc");
      const r = await ctx.bash.execute("ls /*.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("a.txt");
      expect(r.stdout).toContain("b.txt");
      expect(r.stdout).not.toContain("c.log");
    });

    it("passes literal when no matches", async () => {
      const r = await ctx.bash.execute("ls /*.zzz");
      // Should fail because *.zzz doesn't match anything, passed as literal
      expect(r.exitCode).not.toBe(0);
    });

    it("reuses a directory listing for multiple globs in the same directory", async () => {
      await ctx.fs.writeFile("/a.txt", "aaa");
      await ctx.fs.writeFile("/b.log", "bbb");
      await ctx.fs.writeFile("/c.txt", "ccc");
      const readdirSpy = vi.spyOn(ctx.fs, "readdirWithTypes");

      const r = await ctx.bash.execute("ls /*.txt /*.log");

      expect(r.exitCode).toBe(0);
      expect(readdirSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -- Quoting ----------------------------------------------------------------

  describe("quoting", () => {
    it("preserves spaces inside double quotes", async () => {
      const r = await ctx.bash.execute('echo "hello   world"');
      expect(r.stdout).toBe("hello   world\n");
    });

    it("preserves spaces inside single quotes", async () => {
      const r = await ctx.bash.execute("echo 'hello   world'");
      expect(r.stdout).toBe("hello   world\n");
    });

    it("handles mixed quotes", async () => {
      const r = await ctx.bash.execute(`echo "it's" 'a "test"'`);
      expect(r.stdout).toBe(`it's a "test"\n`);
    });
  });
});
