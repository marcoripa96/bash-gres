import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupBash } from "./_setup.js";

describe("bash: native parity", () => {
  const ctx = setupBash("bash-native-parity");

  it("matches native ls output for a single file", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-ls-file-"));

    try {
      await writeFile(join(root, "single.txt"), "data");
      await ctx.fs.writeFile("/single.txt", "data");

      const native = await runNative("ls single.txt", root);
      const virtual = await ctx.bash.execute("ls single.txt");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native ls output for mixed file and directory targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-ls-multi-"));

    try {
      await writeFile(join(root, "a.txt"), "a");
      await mkdir(join(root, "dir1"));
      await mkdir(join(root, "dir2"));
      await writeFile(join(root, "dir1", "x.txt"), "x");
      await writeFile(join(root, "dir2", "y.txt"), "y");

      await ctx.fs.writeFile("/a.txt", "a");
      await ctx.fs.mkdir("/dir1");
      await ctx.fs.mkdir("/dir2");
      await ctx.fs.writeFile("/dir1/x.txt", "x");
      await ctx.fs.writeFile("/dir2/y.txt", "y");

      const native = await runNative("ls a.txt dir1 dir2", root);
      const virtual = await ctx.bash.execute("ls a.txt dir1 dir2");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native ls output for symlinked directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-ls-linkdir-"));

    try {
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real", "inside.txt"), "data");
      await symlink("real", join(root, "linkdir"));

      await ctx.fs.mkdir("/real");
      await ctx.fs.writeFile("/real/inside.txt", "data");
      await ctx.fs.symlink("real", "/linkdir");

      const native = await runNative("ls linkdir", root);
      const virtual = await ctx.bash.execute("ls linkdir");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native find output for file roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-find-file-"));

    try {
      await writeFile(join(root, "file.txt"), "data");
      await ctx.fs.writeFile("/file.txt", "data");

      const native = await runNative("find file.txt", root);
      const virtual = await ctx.bash.execute("find file.txt");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native find output when the root name matches -name", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-find-root-"));

    try {
      const native = await runNative("find . -name .", root);
      const virtual = await ctx.bash.execute("find . -name .");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native head output for multiple files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-head-"));

    try {
      await writeFile(join(root, "a.txt"), "1\n2\n3\n");
      await writeFile(join(root, "b.txt"), "x\ny\n");
      await ctx.fs.writeFile("/a.txt", "1\n2\n3\n");
      await ctx.fs.writeFile("/b.txt", "x\ny\n");

      const native = await runNative("head a.txt b.txt", root);
      const virtual = await ctx.bash.execute("head a.txt b.txt");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native tail output for zero lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-tail-"));

    try {
      await writeFile(join(root, "data.txt"), "1\n2\n3\n");
      await ctx.fs.writeFile("/data.txt", "1\n2\n3\n");

      const native = await runNative("tail -n 0 data.txt", root);
      const virtual = await ctx.bash.execute("tail -n 0 data.txt");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native cat output when mixing files and stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-cat-"));

    try {
      await writeFile(join(root, "file.txt"), "file\n");
      await ctx.fs.writeFile("/file.txt", "file\n");

      const native = await runNative("printf 'stdin\\n' | cat file.txt - file.txt", root);
      const virtual = await ctx.bash.execute("echo stdin | cat file.txt - file.txt");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native cp behavior for multiple sources into a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-cp-"));

    try {
      await writeFile(join(root, "a.txt"), "a");
      await writeFile(join(root, "b.txt"), "b");
      await mkdir(join(root, "dest"));

      await ctx.fs.writeFile("/a.txt", "a");
      await ctx.fs.writeFile("/b.txt", "b");
      await ctx.fs.mkdir("/dest");

      const native = await runNative("cp a.txt b.txt dest", root);
      const virtual = await ctx.bash.execute("cp a.txt b.txt dest");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
      expect(await readFile(join(root, "dest", "a.txt"), "utf8")).toBe(
        await ctx.fs.readFile("/dest/a.txt"),
      );
      expect(await readFile(join(root, "dest", "b.txt"), "utf8")).toBe(
        await ctx.fs.readFile("/dest/b.txt"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native mv behavior for multiple sources into a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-mv-"));

    try {
      await writeFile(join(root, "a.txt"), "a");
      await writeFile(join(root, "b.txt"), "b");
      await mkdir(join(root, "dest"));

      await ctx.fs.writeFile("/a.txt", "a");
      await ctx.fs.writeFile("/b.txt", "b");
      await ctx.fs.mkdir("/dest");

      const native = await runNative("mv a.txt b.txt dest", root);
      const virtual = await ctx.bash.execute("mv a.txt b.txt dest");

      expect(virtual.exitCode).toBe(native.exitCode);
      expect(virtual.stdout).toBe(native.stdout);
      expect(virtual.stderr).toBe(native.stderr);
      expect(await readdir(join(root, "dest"))).toEqual(["a.txt", "b.txt"]);
      expect(await ctx.fs.readdir("/dest")).toEqual(["a.txt", "b.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native touch failure when parent directories are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-touch-"));

    try {
      const native = await runNative("touch missing/file.txt", root);
      const virtual = await ctx.bash.execute("touch missing/file.txt");

      expect(native.exitCode).not.toBe(0);
      expect(virtual.exitCode).not.toBe(0);
      expect(native.stdout).toBe(virtual.stdout);
      expect(await ctx.fs.exists("/missing/file.txt")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runNative(
  command: string,
  cwd: string,
  stdin = "",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin.end(stdin);
  });
}
