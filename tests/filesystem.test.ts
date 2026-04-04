import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../src/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

describe.each(TEST_ADAPTERS)("PgFileSystem [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await client.query(
      "DELETE FROM fs_nodes WHERE workspace_id = $1",
      ["test-workspace"],
    );
    fs = new PgFileSystem({ db: client, workspaceId: "test-workspace" });
    await fs.init();
  });

  describe("writeFile + readFile", () => {
    it("writes and reads text file", async () => {
      await fs.writeFile("/hello.txt", "world");
      expect(await fs.readFile("/hello.txt")).toBe("world");
    });

    it("writes and reads nested file", async () => {
      await fs.mkdir("/docs", { recursive: true });
      await fs.writeFile("/docs/readme.md", "# Hello");
      expect(await fs.readFile("/docs/readme.md")).toBe("# Hello");
    });

    it("overwrites existing file", async () => {
      await fs.writeFile("/test.txt", "first");
      await fs.writeFile("/test.txt", "second");
      expect(await fs.readFile("/test.txt")).toBe("second");
    });

    it("throws ENOENT for non-existent file", async () => {
      await expect(fs.readFile("/nope.txt")).rejects.toThrow("ENOENT");
    });

    it("auto-creates parent dirs with recursive option", async () => {
      await fs.writeFile("/a/b/c/file.txt", "deep", { recursive: true });
      expect(await fs.readFile("/a/b/c/file.txt")).toBe("deep");
    });

    it("reads ranged slices through symlinks", async () => {
      await fs.writeFile("/target.txt", "abcdef");
      await fs.symlink("/target.txt", "/link.txt");

      expect(await fs.readFile("/link.txt", { offset: 1, limit: 3 })).toBe("bcd");
    });

    it("reads ranged slices from binary-backed files", async () => {
      await fs.writeFile(
        "/bytes.bin",
        new TextEncoder().encode("abcdef"),
      );

      expect(await fs.readFile("/bytes.bin", { offset: 2, limit: 2 })).toBe("cd");
    });
  });

  describe("readFileBuffer", () => {
    it("reads text as buffer", async () => {
      await fs.writeFile("/hello.txt", "world");
      const buf = await fs.readFileBuffer("/hello.txt");
      expect(buf).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(buf)).toBe("world");
    });

    it("reads binary data", async () => {
      const data = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
      await fs.writeFile("/bin.dat", data);
      const buf = await fs.readFileBuffer("/bin.dat");
      // postgres.js returns Buffer (a Uint8Array subclass), so compare bytes
      expect(new Uint8Array(buf)).toEqual(data);
    });
  });

  describe("appendFile", () => {
    it("appends to existing file", async () => {
      await fs.writeFile("/log.txt", "line1\n");
      await fs.appendFile("/log.txt", "line2\n");
      expect(await fs.readFile("/log.txt")).toBe("line1\nline2\n");
    });

    it("creates file if not exists", async () => {
      await fs.appendFile("/new.txt", "content");
      expect(await fs.readFile("/new.txt")).toBe("content");
    });
  });

  describe("exists", () => {
    it("returns false for non-existent path", async () => {
      expect(await fs.exists("/nope")).toBe(false);
    });

    it("returns true for existing file", async () => {
      await fs.writeFile("/test.txt", "hi");
      expect(await fs.exists("/test.txt")).toBe(true);
    });

    it("returns true for directory", async () => {
      await fs.mkdir("/mydir");
      expect(await fs.exists("/mydir")).toBe(true);
    });
  });

  describe("stat", () => {
    it("returns file stat", async () => {
      await fs.writeFile("/test.txt", "hello");
      const s = await fs.stat("/test.txt");
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
      expect(s.isSymbolicLink).toBe(false);
      expect(s.size).toBe(5);
      expect(s.mtime).toBeInstanceOf(Date);
    });

    it("returns directory stat", async () => {
      await fs.mkdir("/mydir");
      const s = await fs.stat("/mydir");
      expect(s.isFile).toBe(false);
      expect(s.isDirectory).toBe(true);
    });

    it("throws ENOENT for non-existent", async () => {
      await expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("mkdir", () => {
    it("creates a directory", async () => {
      await fs.mkdir("/newdir");
      const s = await fs.stat("/newdir");
      expect(s.isDirectory).toBe(true);
    });

    it("recursive creates nested dirs", async () => {
      await fs.mkdir("/a/b/c", { recursive: true });
      expect(await fs.exists("/a")).toBe(true);
      expect(await fs.exists("/a/b")).toBe(true);
      expect(await fs.exists("/a/b/c")).toBe(true);
    });

    it("throws EEXIST for existing dir without recursive", async () => {
      await fs.mkdir("/mydir");
      await expect(fs.mkdir("/mydir")).rejects.toThrow("EEXIST");
    });

    it("recursive is idempotent", async () => {
      await fs.mkdir("/mydir", { recursive: true });
      await fs.mkdir("/mydir", { recursive: true });
    });
  });

  describe("readdir", () => {
    it("lists immediate children", async () => {
      await fs.mkdir("/parent");
      await fs.writeFile("/parent/a.txt", "a");
      await fs.writeFile("/parent/b.txt", "b");
      await fs.mkdir("/parent/sub");
      const entries = await fs.readdir("/parent");
      expect(entries.sort()).toEqual(["a.txt", "b.txt", "sub"]);
    });

    it("does not list grandchildren", async () => {
      await fs.mkdir("/parent/sub", { recursive: true });
      await fs.writeFile("/parent/sub/deep.txt", "deep");
      await fs.writeFile("/parent/top.txt", "top");
      const entries = await fs.readdir("/parent");
      expect(entries.sort()).toEqual(["sub", "top.txt"]);
    });

    it("throws ENOENT for non-existent dir", async () => {
      await expect(fs.readdir("/nope")).rejects.toThrow("ENOENT");
    });

    it("readdirWithStats returns metadata in one pass", async () => {
      await fs.mkdir("/parent");
      await fs.writeFile("/parent/a.txt", "hello");
      await fs.symlink("/parent/a.txt", "/parent/link.txt");

      const entries = await fs.readdirWithStats("/parent");
      const byName = new Map(entries.map((entry) => [entry.name, entry]));

      expect(byName.get("a.txt")).toMatchObject({
        isFile: true,
        size: 5,
        symlinkTarget: null,
      });
      expect(byName.get("link.txt")).toMatchObject({
        isSymbolicLink: true,
        symlinkTarget: "/parent/a.txt",
      });
    });

    it("walk returns nested descendants in path order", async () => {
      await fs.mkdir("/parent/sub", { recursive: true });
      await fs.writeFile("/parent/a.txt", "hello");
      await fs.writeFile("/parent/sub/b.txt", "world");

      expect(await fs.walk("/parent")).toMatchObject([
        { path: "/parent/a.txt", depth: 1, isFile: true },
        { path: "/parent/sub", depth: 1, isDirectory: true },
        { path: "/parent/sub/b.txt", depth: 2, isFile: true },
      ]);
    });
  });

  describe("rm", () => {
    it("removes a file", async () => {
      await fs.writeFile("/doomed.txt", "bye");
      await fs.rm("/doomed.txt");
      expect(await fs.exists("/doomed.txt")).toBe(false);
    });

    it("removes empty directory", async () => {
      await fs.mkdir("/empty");
      await fs.rm("/empty");
      expect(await fs.exists("/empty")).toBe(false);
    });

    it("throws ENOTEMPTY for non-empty dir without recursive", async () => {
      await fs.mkdir("/full");
      await fs.writeFile("/full/file.txt", "hi");
      await expect(fs.rm("/full")).rejects.toThrow("ENOTEMPTY");
    });

    it("recursive removes dir and contents", async () => {
      await fs.mkdir("/tree/sub", { recursive: true });
      await fs.writeFile("/tree/sub/file.txt", "data");
      await fs.rm("/tree", { recursive: true });
      expect(await fs.exists("/tree")).toBe(false);
      expect(await fs.exists("/tree/sub")).toBe(false);
    });

    it("recursive removes deep trees with siblings", async () => {
      await fs.mkdir("/tree/a/b", { recursive: true });
      await fs.mkdir("/tree/a/c", { recursive: true });
      await fs.mkdir("/tree/d/e", { recursive: true });
      await fs.writeFile("/tree/a/b/one.txt", "1");
      await fs.writeFile("/tree/a/c/two.txt", "2");
      await fs.writeFile("/tree/d/e/three.txt", "3");

      await fs.rm("/tree", { recursive: true });

      expect(await fs.exists("/tree")).toBe(false);
      expect(await fs.exists("/tree/a/b/one.txt")).toBe(false);
      expect(await fs.exists("/tree/d/e/three.txt")).toBe(false);
    });

    it("force ignores non-existent", async () => {
      await fs.rm("/nope", { force: true });
    });
  });

  describe("cp", () => {
    it("copies a file", async () => {
      await fs.writeFile("/src.txt", "data");
      await fs.cp("/src.txt", "/dst.txt");
      expect(await fs.readFile("/dst.txt")).toBe("data");
    });

    it("recursive copies directory", async () => {
      await fs.mkdir("/srcdir");
      await fs.writeFile("/srcdir/a.txt", "a");
      await fs.cp("/srcdir", "/dstdir", { recursive: true });
      expect(await fs.readFile("/dstdir/a.txt")).toBe("a");
    });

    it("rejects copy to subdirectory of itself", async () => {
      await fs.mkdir("/srcdir");
      await fs.writeFile("/srcdir/a.txt", "a");
      await expect(
        fs.cp("/srcdir", "/srcdir/sub", { recursive: true }),
      ).rejects.toThrow("EINVAL");
    });
  });

  describe("mv", () => {
    it("renames a file", async () => {
      await fs.writeFile("/old.txt", "data");
      await fs.mv("/old.txt", "/new.txt");
      expect(await fs.exists("/old.txt")).toBe(false);
      expect(await fs.readFile("/new.txt")).toBe("data");
    });

    it("moves file to different directory", async () => {
      await fs.mkdir("/target");
      await fs.writeFile("/src.txt", "data");
      await fs.mv("/src.txt", "/target/moved.txt");
      expect(await fs.readFile("/target/moved.txt")).toBe("data");
    });

    it("moves directory with descendants", async () => {
      await fs.mkdir("/srcdir/sub", { recursive: true });
      await fs.writeFile("/srcdir/sub/file.txt", "data");
      await fs.mkdir("/dest");
      await fs.mv("/srcdir", "/dest/moved");
      expect(await fs.readFile("/dest/moved/sub/file.txt")).toBe("data");
    });
  });

  describe("glob", () => {
    it("matches patterns with a literal directory prefix", async () => {
      await fs.mkdir("/src/lib", { recursive: true });
      await fs.writeFile("/src/app.ts", "app");
      await fs.writeFile("/src/lib/util.ts", "util");
      await fs.writeFile("/docs/readme.md", "docs", { recursive: true });

      const results = await fs.glob("lib/**/*.ts", { cwd: "/src" });

      expect(results).toEqual(["/src/lib/util.ts"]);
    });

    it("matches exact file patterns", async () => {
      await fs.writeFile("/src/app.ts", "app", { recursive: true });
      await fs.writeFile("/src/other.ts", "other");

      expect(await fs.glob("app.ts", { cwd: "/src" })).toEqual(["/src/app.ts"]);
    });

    it("matches only direct children for single-segment patterns", async () => {
      await fs.mkdir("/src/lib", { recursive: true });
      await fs.writeFile("/src/app.ts", "app");
      await fs.writeFile("/src/lib/nested.ts", "nested");

      expect(await fs.glob("*.ts", { cwd: "/src" })).toEqual(["/src/app.ts"]);
    });

    it("matches exact basenames recursively", async () => {
      await fs.mkdir("/src/lib/deep", { recursive: true });
      await fs.writeFile("/src/app.ts", "app");
      await fs.writeFile("/src/lib/app.ts", "lib app");
      await fs.writeFile("/src/lib/deep/app.ts", "deep app");
      await fs.writeFile("/src/lib/deep/other.ts", "other");

      expect(await fs.glob("**/app.ts", { cwd: "/src" })).toEqual([
        "/src/app.ts",
        "/src/lib/app.ts",
        "/src/lib/deep/app.ts",
      ]);
    });
  });

  describe("symlink + readlink", () => {
    it("creates and reads symlink", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.readlink("/link.txt")).toBe("/target.txt");
    });

    it("readFile follows symlink", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.readFile("/link.txt")).toBe("real content");
    });

    it("lstat returns symlink info", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      const s = await fs.lstat("/link.txt");
      expect(s.isSymbolicLink).toBe(true);
    });

    it("preserves relative symlink targets", async () => {
      await fs.mkdir("/dir", { recursive: true });
      await fs.mkdir("/links", { recursive: true });
      await fs.writeFile("/dir/target.txt", "real content");
      await fs.symlink("../dir/target.txt", "/links/link.txt");

      expect(await fs.readlink("/links/link.txt")).toBe("../dir/target.txt");
      expect(await fs.readFile("/links/link.txt")).toBe("real content");
    });

    it("readdir follows symlinks to directories", async () => {
      await fs.mkdir("/real", { recursive: true });
      await fs.writeFile("/real/file.txt", "data");
      await fs.symlink("/real", "/alias");

      expect(await fs.readdir("/alias")).toEqual(["file.txt"]);
    });

    it("realpath resolves relative symlinks", async () => {
      await fs.mkdir("/dir", { recursive: true });
      await fs.mkdir("/links", { recursive: true });
      await fs.writeFile("/dir/target.txt", "real content");
      await fs.symlink("../dir/target.txt", "/links/link.txt");

      expect(await fs.realpath("/links/link.txt")).toBe("/dir/target.txt");
    });
  });

  describe("chmod + utimes", () => {
    it("chmod follows symlinks and updates the target", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");

      await fs.chmod("/link.txt", 0o600);

      expect((await fs.stat("/target.txt")).mode).toBe(0o600);
      expect((await fs.lstat("/link.txt")).mode).toBe(0o777);
    });

    it("utimes follows symlinks and leaves the link metadata unchanged", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      const linkBefore = await fs.lstat("/link.txt");
      const targetTime = new Date("2024-01-01T00:00:00.000Z");

      await fs.utimes("/link.txt", targetTime, targetTime);

      expect((await fs.stat("/target.txt")).mtime.getTime()).toBe(
        targetTime.getTime(),
      );
      expect((await fs.lstat("/link.txt")).mtime.getTime()).toBe(
        linkBefore.mtime.getTime(),
      );
    });
  });

  describe("workspace isolation", () => {
    it("different workspaces see different files", async () => {
      const fs2 = new PgFileSystem({ db: client, workspaceId: "other-workspace" });
      await fs2.init();

      await fs.writeFile("/shared-name.txt", "workspace1");
      await fs2.writeFile("/shared-name.txt", "workspace2");

      expect(await fs.readFile("/shared-name.txt")).toBe("workspace1");
      expect(await fs2.readFile("/shared-name.txt")).toBe("workspace2");

      // cleanup
      await fs2.dispose();
    });
  });

  describe("dispose", () => {
    it("removes all workspace data", async () => {
      await fs.writeFile("/a.txt", "a");
      await fs.mkdir("/dir");
      await fs.writeFile("/dir/b.txt", "b");
      await fs.dispose();
      // After dispose, root no longer exists
      await expect(fs.readdir("/")).rejects.toThrow();
    });
  });
});
