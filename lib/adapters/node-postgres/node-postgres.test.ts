import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createNodePgClient } from "./index.js";
import { setup } from "../../core/setup.js";
import { PgFileSystem } from "../../core/filesystem.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const WORKSPACE_ID = "node-pg-adapter-test";

describe("node-postgres adapter", () => {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  const client = createNodePgClient(pool);

  beforeAll(async () => {
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM fs_entries WHERE workspace_id = $1", [WORKSPACE_ID]);
    await pool.query("DELETE FROM version_ancestors WHERE workspace_id = $1", [WORKSPACE_ID]);
    await pool.query("DELETE FROM fs_versions WHERE workspace_id = $1", [WORKSPACE_ID]);
    await pool.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [WORKSPACE_ID]);
  });

  it("initializes PgFileSystem with node-postgres client", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    const stat = await fs.stat("/");
    expect(stat.isDirectory).toBe(true);
  });

  it("creates and reads files", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    await fs.writeFile("/hello.txt", "hello from node-postgres");
    const content = await fs.readFile("/hello.txt");
    expect(content).toBe("hello from node-postgres");
  });

  it("creates directories and lists entries", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    await fs.mkdir("/docs");
    await fs.writeFile("/docs/readme.txt", "readme");

    const entries = await fs.readdir("/docs");
    expect(entries).toEqual(["readme.txt"]);
  });

  it("runs transactions through node-postgres bridge", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    await fs.writeFile("/a.txt", "aaa");
    await fs.writeFile("/b.txt", "bbb");
    await fs.rm("/a.txt");

    const entries = await fs.readdir("/");
    expect(entries).toContain("b.txt");
    expect(entries).not.toContain("a.txt");
  });

  it("handles nested transactions via savepoints", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    await fs.writeFile("/outer.txt", "outer");
    await fs.mkdir("/nested", { recursive: true });
    await fs.writeFile("/nested/inner.txt", "inner");

    expect(await fs.readFile("/outer.txt")).toBe("outer");
    expect(await fs.readFile("/nested/inner.txt")).toBe("inner");
  });

  it("reads and writes binary data", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    const data = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
    await fs.writeFile("/bin.dat", data);
    const buf = await fs.readFileBuffer("/bin.dat");
    expect(new Uint8Array(buf)).toEqual(data);
  });
});
