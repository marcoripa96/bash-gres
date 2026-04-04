import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgresLib from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createDrizzleClient } from "./adapter.js";
import { setup } from "../../core/setup.js";
import { PgFileSystem } from "../../core/filesystem.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const SESSION_ID = "drizzle-adapter-test";

describe("drizzle adapter", () => {
  const sql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
  const db = drizzle(sql);
  const client = createDrizzleClient(db);

  beforeAll(async () => {
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM fs_nodes WHERE session_id = ${SESSION_ID}`;
  });

  it("initializes PgFileSystem with drizzle client", async () => {
    const fs = new PgFileSystem({ db: client, sessionId: SESSION_ID });
    await fs.init();

    const stat = await fs.stat("/");
    expect(stat.isDirectory).toBe(true);
  });

  it("creates and reads files", async () => {
    const fs = new PgFileSystem({ db: client, sessionId: SESSION_ID });
    await fs.init();

    await fs.writeFile("/hello.txt", "hello from drizzle");
    const content = await fs.readFile("/hello.txt");
    expect(content).toBe("hello from drizzle");
  });

  it("creates directories and lists entries", async () => {
    const fs = new PgFileSystem({ db: client, sessionId: SESSION_ID });
    await fs.init();

    await fs.mkdir("/docs");
    await fs.writeFile("/docs/readme.txt", "readme");

    const entries = await fs.readdir("/docs");
    expect(entries).toEqual(["readme.txt"]);
  });

  it("runs transactions through drizzle bridge", async () => {
    const fs = new PgFileSystem({ db: client, sessionId: SESSION_ID });
    await fs.init();

    await fs.writeFile("/a.txt", "aaa");
    await fs.writeFile("/b.txt", "bbb");
    await fs.rm("/a.txt");

    const entries = await fs.readdir("/");
    expect(entries).toContain("b.txt");
    expect(entries).not.toContain("a.txt");
  });
});
