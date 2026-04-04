import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestClient, resetDb } from "./helpers.js";
import { PgFileSystem } from "../src/core/filesystem.js";
import { setup } from "../src/core/setup.js";
import type { SqlClient } from "./helpers.js";
import type postgres from "postgres";

describe("PgFileSystem", () => {
  let sql: postgres.Sql;
  let db: SqlClient;
  let fs: PgFileSystem;

  beforeAll(async () => {
    const test = createTestClient();
    sql = test.sql;
    db = test.client;
    await setup(db, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
  });

  afterAll(async () => {
    await resetDb(db);
    await sql.end();
  });

  beforeEach(async () => {
    await db.query(
      "DELETE FROM fs_nodes WHERE session_id = $1",
      ["test-session"],
    );
    fs = new PgFileSystem({ db, sessionId: "test-session" });
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
      expect(buf).toEqual(data);
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
  });

  describe("session isolation", () => {
    it("different sessions see different files", async () => {
      const fs2 = new PgFileSystem({ db, sessionId: "other-session" });
      await fs2.init();

      await fs.writeFile("/shared-name.txt", "session1");
      await fs2.writeFile("/shared-name.txt", "session2");

      expect(await fs.readFile("/shared-name.txt")).toBe("session1");
      expect(await fs2.readFile("/shared-name.txt")).toBe("session2");

      // cleanup
      await fs2.dispose();
    });
  });

  describe("dispose", () => {
    it("removes all session data", async () => {
      await fs.writeFile("/a.txt", "a");
      await fs.mkdir("/dir");
      await fs.writeFile("/dir/b.txt", "b");
      await fs.dispose();
      // After dispose, root no longer exists
      await expect(fs.readdir("/")).rejects.toThrow();
    });
  });
});
