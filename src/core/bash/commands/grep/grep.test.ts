import { describe, it, expect, vi } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";
import { TEST_ADAPTERS } from "../../../../../tests/helpers.js";

describe.each(TEST_ADAPTERS)("bash: grep [%s]", (_name, factory) => {
  const ctx = setupBash("bash-grep", factory);

  it("matches lines containing pattern", async () => {
    await ctx.fs.writeFile(
      "/code.ts",
      "const foo = 1;\nconst bar = 2;\nconst foo_bar = 3;",
    );
    const r = await ctx.bash.execute("grep foo /code.ts");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("const foo = 1;");
    expect(r.stdout).toContain("const foo_bar = 3;");
    expect(r.stdout).not.toContain("const bar = 2;");
  });

  it("returns exit code 1 when no matches", async () => {
    await ctx.fs.writeFile("/file.txt", "hello world");
    const r = await ctx.bash.execute("grep zzz /file.txt");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("supports regex patterns", async () => {
    await ctx.fs.writeFile(
      "/data.txt",
      "abc123\ndef456\nabc789\nxyz000\n",
    );
    const r = await ctx.bash.execute("grep ^abc /data.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("abc123");
    expect(r.stdout).toContain("abc789");
    expect(r.stdout).not.toContain("def456");
    expect(r.stdout).not.toContain("xyz000");
  });

  it("fails on missing pattern", async () => {
    const r = await ctx.bash.execute("grep");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing pattern");
  });

  describe("-i flag", () => {
    it("searches case-insensitively", async () => {
      await ctx.fs.writeFile("/file.txt", "Hello World\nhello world\nHELLO WORLD\n");
      const r = await ctx.bash.execute("grep -i hello /file.txt");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
    });
  });

  describe("-n flag", () => {
    it("shows line numbers", async () => {
      await ctx.fs.writeFile(
        "/file.txt",
        "alpha\nbeta\ngamma\nbeta again\n",
      );
      const r = await ctx.bash.execute("grep -n beta /file.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("2:");
      expect(r.stdout).toContain("4:");
    });
  });

  describe("-r flag", () => {
    it("searches recursively in directory", async () => {
      await ctx.fs.mkdir("/project/src", { recursive: true });
      await ctx.fs.writeFile("/project/src/app.ts", "import foo from 'bar';\n");
      await ctx.fs.writeFile("/project/src/util.ts", "export const foo = 1;\n");
      await ctx.fs.writeFile("/project/readme.md", "no match here\n");
      const r = await ctx.bash.execute("grep -r foo /project");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("app.ts");
      expect(r.stdout).toContain("util.ts");
      expect(r.stdout).not.toContain("readme.md");
    });

    it("-R also works", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/file.txt", "findme\n");
      const r = await ctx.bash.execute("grep -R findme /dir");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("findme");
    });

    it("shows file paths in recursive output", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/a.txt", "match\n");
      await ctx.fs.writeFile("/dir/b.txt", "match\n");
      const r = await ctx.bash.execute("grep -r match /dir");
      expect(r.stdout).toContain("/dir/a.txt:");
      expect(r.stdout).toContain("/dir/b.txt:");
    });

    it("uses subtree walk instead of recursive readdir calls", async () => {
      await ctx.fs.mkdir("/dir/sub/deep", { recursive: true });
      await ctx.fs.writeFile("/dir/a.txt", "match\n");
      await ctx.fs.writeFile("/dir/sub/b.txt", "match\n");
      await ctx.fs.writeFile("/dir/sub/deep/c.txt", "match\n");

      const walkSpy = vi.spyOn(ctx.fs, "walk");
      const readdirSpy = vi.spyOn(ctx.fs, "readdirWithTypes");

      const r = await ctx.bash.execute("grep -r match /dir");

      expect(r.exitCode).toBe(0);
      expect(walkSpy).toHaveBeenCalledTimes(1);
      expect(readdirSpy).not.toHaveBeenCalled();
    });
  });

  describe("combined flags", () => {
    it("-rn shows file paths and line numbers", async () => {
      await ctx.fs.mkdir("/dir");
      await ctx.fs.writeFile("/dir/file.txt", "line1\ntarget\nline3\n");
      const r = await ctx.bash.execute("grep -rn target /dir");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("/dir/file.txt:");
      expect(r.stdout).toContain("2:");
    });

    it("-in combines case-insensitive and line numbers", async () => {
      await ctx.fs.writeFile("/file.txt", "Hello\nworld\nhello\n");
      const r = await ctx.bash.execute("grep -in hello /file.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("1:");
      expect(r.stdout).toContain("3:");
    });
  });

  describe("multiple files", () => {
    it("shows filename prefix with multiple files", async () => {
      await ctx.fs.writeFile("/a.txt", "match here\n");
      await ctx.fs.writeFile("/b.txt", "no luck\n");
      await ctx.fs.writeFile("/c.txt", "match too\n");
      const r = await ctx.bash.execute("grep match /a.txt /b.txt /c.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("/a.txt:");
      expect(r.stdout).toContain("/c.txt:");
    });
  });

  describe("piped input", () => {
    it("filters piped input", async () => {
      await ctx.fs.writeFile(
        "/log.txt",
        "INFO start\nERROR fail\nINFO end\n",
      );
      const r = await ctx.bash.execute("cat /log.txt | grep ERROR");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("ERROR fail\n");
    });

    it("returns exit code 1 when no piped lines match", async () => {
      await ctx.fs.writeFile("/data.txt", "no match at all\n");
      const r = await ctx.bash.execute("cat /data.txt | grep zzz");
      expect(r.exitCode).toBe(1);
    });

    it("-n shows line numbers in piped input", async () => {
      await ctx.fs.writeFile("/data.txt", "a\nb\nc\nb\n");
      const r = await ctx.bash.execute("cat /data.txt | grep -n b");
      expect(r.stdout).toContain("2:");
      expect(r.stdout).toContain("4:");
    });
  });
});
