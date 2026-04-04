import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestClient } from "../../tests/helpers.js";
import { ensureSetup } from "../../tests/global-setup.js";
import { PgFileSystem } from "./filesystem.js";
import { FsError } from "./types.js";
import type { SqlClient } from "./types.js";
import type postgres from "postgres";

const WORKSPACE = "test-readonly";

describe("PgFileSystem permissions", () => {
  let sql: postgres.Sql;
  let client: SqlClient;
  let rwFs: PgFileSystem;
  let roFs: PgFileSystem;

  beforeAll(async () => {
    await ensureSetup();
    const test = createTestClient();
    sql = test.sql;
    client = test.client;
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [
      WORKSPACE,
    ]);
    rwFs = new PgFileSystem({ db: client, workspaceId: WORKSPACE });
    await rwFs.init();

    roFs = new PgFileSystem({
      db: client,
      workspaceId: WORKSPACE,
      permissions: { read: true, write: false },
    });
  });

  describe("read operations succeed", () => {
    beforeEach(async () => {
      await rwFs.mkdir("/docs", { recursive: true });
      await rwFs.writeFile("/hello.txt", "world");
      await rwFs.writeFile("/docs/readme.md", "# Docs");
    });

    it("readFile", async () => {
      expect(await roFs.readFile("/hello.txt")).toBe("world");
    });

    it("exists", async () => {
      expect(await roFs.exists("/hello.txt")).toBe(true);
      expect(await roFs.exists("/nope.txt")).toBe(false);
    });

    it("stat", async () => {
      const s = await roFs.stat("/hello.txt");
      expect(s.isFile).toBe(true);
    });

    it("readdir", async () => {
      const entries = await roFs.readdir("/");
      expect(entries).toContain("hello.txt");
      expect(entries).toContain("docs");
    });

    it("readFile in subdirectory", async () => {
      expect(await roFs.readFile("/docs/readme.md")).toBe("# Docs");
    });
  });

  describe("write operations throw EPERM", () => {
    it("writeFile", async () => {
      await expect(roFs.writeFile("/new.txt", "data")).rejects.toThrow("EPERM");
    });

    it("mkdir", async () => {
      await expect(roFs.mkdir("/newdir")).rejects.toThrow("EPERM");
    });

    it("appendFile", async () => {
      await rwFs.writeFile("/exist.txt", "a");
      await expect(roFs.appendFile("/exist.txt", "b")).rejects.toThrow("EPERM");
    });

    it("rm", async () => {
      await rwFs.writeFile("/doomed.txt", "bye");
      await expect(roFs.rm("/doomed.txt")).rejects.toThrow("EPERM");
    });

    it("cp", async () => {
      await rwFs.writeFile("/src.txt", "data");
      await expect(roFs.cp("/src.txt", "/dst.txt")).rejects.toThrow("EPERM");
    });

    it("mv", async () => {
      await rwFs.writeFile("/old.txt", "data");
      await expect(roFs.mv("/old.txt", "/new.txt")).rejects.toThrow("EPERM");
    });

    it("symlink", async () => {
      await expect(roFs.symlink("/target", "/link")).rejects.toThrow("EPERM");
    });

    it("throws FsError instance", async () => {
      await expect(roFs.writeFile("/x.txt", "y")).rejects.toBeInstanceOf(
        FsError,
      );
    });
  });

  describe("defaults to read-write", () => {
    it("permissions default to { read: true, write: true }", () => {
      expect(rwFs.permissions).toEqual({ read: true, write: true });
    });

    it("readonly fs has { read: true, write: false }", () => {
      expect(roFs.permissions).toEqual({ read: true, write: false });
    });
  });
});
