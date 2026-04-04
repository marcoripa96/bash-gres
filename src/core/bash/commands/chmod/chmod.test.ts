import { describe, it, expect } from "vitest";
import { setupBash } from "../../../../../tests/bash/_setup.js";

describe("bash: chmod", () => {
  const ctx = setupBash("bash-chmod");

  describe("octal mode", () => {
    it("sets mode with octal notation", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      const r = await ctx.bash.execute("chmod 755 /file.txt");
      expect(r.exitCode).toBe(0);
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode).toBe(0o755);
    });

    it("sets mode 644", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.bash.execute("chmod 644 /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode).toBe(0o644);
    });

    it("sets mode 0 (no permissions)", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.bash.execute("chmod 0 /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode).toBe(0);
    });

    it("sets mode 777", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.bash.execute("chmod 777 /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode).toBe(0o777);
    });
  });

  describe("symbolic mode", () => {
    it("u+x adds user execute", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0o644);
      await ctx.bash.execute("chmod u+x /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o100).toBe(0o100);
    });

    it("go-r removes group and other read", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0o644);
      await ctx.bash.execute("chmod go-r /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o044).toBe(0);
    });

    it("a+rw adds read/write for all", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0);
      await ctx.bash.execute("chmod a+rw /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o666).toBe(0o666);
    });

    it("+x adds execute for all (empty who = a)", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0o644);
      await ctx.bash.execute("chmod +x /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o111).toBe(0o111);
    });

    it("u=rwx sets user permissions exactly", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0o000);
      await ctx.bash.execute("chmod u=rwx /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o700).toBe(0o700);
      expect(stat.mode & 0o077).toBe(0);
    });

    it("g+w adds group write", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0o644);
      await ctx.bash.execute("chmod g+w /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o020).toBe(0o020);
    });

    it("o-rwx removes all other permissions", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      await ctx.fs.chmod("/file.txt", 0o777);
      await ctx.bash.execute("chmod o-rwx /file.txt");
      const stat = await ctx.fs.stat("/file.txt");
      expect(stat.mode & 0o007).toBe(0);
      expect(stat.mode & 0o770).toBe(0o770);
    });
  });

  describe("error handling", () => {
    it("fails on missing operand", async () => {
      const r = await ctx.bash.execute("chmod");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("missing operand");
    });

    it("fails on invalid mode string", async () => {
      await ctx.fs.writeFile("/file.txt", "data");
      const r = await ctx.bash.execute("chmod zzz /file.txt");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("invalid mode");
    });

    it("fails on non-existent file", async () => {
      const r = await ctx.bash.execute("chmod 755 /ghost.txt");
      expect(r.exitCode).toBe(1);
    });
  });
});
