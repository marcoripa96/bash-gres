import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "../../tests/helpers.js";
import { ensureSetup } from "../../tests/global-setup.js";
import { PgFileSystem } from "./filesystem.js";
import { isPlainRead } from "./readonly.js";
import { FsError } from "./types.js";
import type { SqlClient } from "./types.js";

const WORKSPACE = "test-readonly";

describe.each(TEST_ADAPTERS)("PgFileSystem permissions [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let rwFs: PgFileSystem;
  let roFs: PgFileSystem;

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
    await resetWorkspace(client, WORKSPACE);
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

  describe("plain reads skip the read-only transaction", () => {
    let sqls: string[];
    let traced: PgFileSystem;

    beforeEach(async () => {
      await rwFs.mkdir("/docs", { recursive: true });
      await rwFs.writeFile("/hello.txt", "line1\nline2\nline3");
      await rwFs.writeFile("/docs/readme.md", "# Docs");
      await rwFs.symlink("/hello.txt", "/link.txt");
      sqls = [];
      traced = new PgFileSystem({
        db: client,
        workspaceId: WORKSPACE,
        permissions: { read: true, write: false },
        trace: (e) => {
          if (e.type === "query") sqls.push(e.sql);
        },
      });
    });

    it("runs every read op as single statements", async () => {
      expect(await traced.readFile("/hello.txt")).toBe("line1\nline2\nline3");
      await traced.readFileBuffer("/hello.txt");
      await traced.readFileRange("/hello.txt", { offset: 1, limit: 3 });
      await traced.readFileLines("/hello.txt", { offset: 2, limit: 2 });
      expect(await traced.readFile("/link.txt")).toBe("line1\nline2\nline3");
      await traced.stat("/hello.txt");
      await traced.lstat("/link.txt");
      expect(await traced.exists("/nope.txt")).toBe(false);
      await traced.realpath("/link.txt");
      await traced.readlink("/link.txt");
      await traced.readdir("/");
      await traced.readdirWithFileTypes("/docs");
      await traced.readdirWithStats("/");
      await traced.walk("/");
      await traced.glob("**/*.md");
      await traced.listVersions();
      await traced.getUsage();

      expect(sqls.length).toBeGreaterThan(0);
      expect(sqls.filter((s) => /SET TRANSACTION READ ONLY/i.test(s))).toEqual(
        [],
      );
    });

    it("still rejects writes in a READ ONLY transaction", async () => {
      await expect(traced.writeFile("/new.txt", "data")).rejects.toThrow(
        "EPERM",
      );
      expect(sqls).toContain("SET TRANSACTION READ ONLY");
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

describe("isPlainRead", () => {
  it.each([
    "SELECT 1",
    "  SELECT path FROM fs_entries WHERE workspace_id = $1",
    "WITH e AS MATERIALIZED (SELECT * FROM fs_entries) SELECT * FROM e",
    "WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t",
    "(SELECT 1) UNION ALL (SELECT 2)",
    "SELECT deleted_at, updated FROM fs_versions OFFSET 1",
  ])("accepts %s", (sql) => {
    expect(isPlainRead(sql)).toBe(true);
  });

  it.each([
    "INSERT INTO fs_entries VALUES (1)",
    "UPDATE fs_versions SET label = $1",
    "DELETE FROM fs_blobs",
    "WITH d AS (DELETE FROM fs_blobs RETURNING 1) SELECT * FROM d",
    "WITH u AS (UPDATE fs_versions SET last_write_at = now() RETURNING 1) SELECT 1",
    "WITH m AS (MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE) SELECT 1",
    "SELECT * FROM fs_versions FOR UPDATE",
    "SELECT * FROM fs_versions FOR NO KEY UPDATE",
    "SELECT * FROM fs_versions FOR SHARE",
    "SELECT * FROM fs_versions FOR KEY SHARE",
    "SELECT * INTO copy FROM fs_entries",
    "SELECT nextval('s')",
    "SELECT setval('s', 1)",
    "SELECT set_config('transaction_read_only', 'off', false)",
    "SELECT pg_advisory_lock(1)",
    "SELECT lo_unlink(1)",
    "SELECT dblink_exec('x')",
    "TRUNCATE fs_entries",
    "CREATE TABLE t (x int)",
    "CALL p()",
    "DO $$ BEGIN END $$",
    "COPY fs_entries TO STDOUT",
    "SET TRANSACTION READ ONLY",
    "VALUES (1)",
    "EXPLAIN ANALYZE DELETE FROM fs_blobs",
  ])("rejects %s", (sql) => {
    expect(isPlainRead(sql)).toBe(false);
  });
});
