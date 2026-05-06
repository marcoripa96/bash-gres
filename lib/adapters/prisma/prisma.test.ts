import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
// The generated client lives under tests/prisma/generated; importing relative
// to this file because the test schema is the only one in the repo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { PrismaClient } from "../../../tests/prisma/generated/client.js";
import { createPrismaClient } from "./adapter.js";
import { setup } from "../../core/setup.js";
import { PgFileSystem } from "../../core/filesystem.js";
import { SqlError } from "../../core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const WORKSPACE_ID = "prisma-adapter-test";

describe("prisma adapter", () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: TEST_DB_URL } },
  });
  const client = createPrismaClient(prisma);

  beforeAll(async () => {
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      "DELETE FROM fs_entries WHERE workspace_id = $1",
      WORKSPACE_ID,
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM version_ancestors WHERE workspace_id = $1",
      WORKSPACE_ID,
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM fs_versions WHERE workspace_id = $1",
      WORKSPACE_ID,
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM fs_version_roots WHERE workspace_id = $1",
      WORKSPACE_ID,
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM fs_blobs WHERE workspace_id = $1",
      WORKSPACE_ID,
    );
  });

  it("initializes PgFileSystem with prisma client", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    const stat = await fs.stat("/");
    expect(stat.isDirectory).toBe(true);
  });

  it("creates and reads files", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    await fs.writeFile("/hello.txt", "hello from prisma");
    const content = await fs.readFile("/hello.txt");
    expect(content).toBe("hello from prisma");
  });

  it("creates directories and lists entries", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await fs.init();

    await fs.mkdir("/docs");
    await fs.writeFile("/docs/readme.txt", "readme");

    const entries = await fs.readdir("/docs");
    expect(entries).toEqual(["readme.txt"]);
  });

  it("runs transactions through prisma bridge", async () => {
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

    const data = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x42, 0x80]);
    await fs.writeFile("/bin.dat", data);
    const buf = await fs.readFileBuffer("/bin.dat");
    expect(new Uint8Array(buf)).toEqual(data);
  });

  it("preserves Postgres SQLSTATE through Prisma error wrapping", async () => {
    let caught: unknown;
    try {
      // Deliberately bad SQL: undefined relation → SQLSTATE 42P01.
      await client.query("SELECT * FROM definitely_not_a_real_table");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SqlError);
    expect((caught as SqlError).code).toBe("42P01");
  });

  it("cooperates with exclude / array params (text[] and lquery[])", async () => {
    // Write through an unrestricted fs, then verify the exclude-scoped fs
    // hides matching paths. This is the path that depends on the adapter
    // serializing JS arrays into Postgres `text[]` / `lquery[]` params.
    const writer = new PgFileSystem({ db: client, workspaceId: WORKSPACE_ID });
    await writer.init();
    await writer.writeFile("/a.txt", "a");
    await writer.mkdir("/node_modules", { recursive: true });
    await writer.writeFile("/node_modules/lib.js", "x");
    await writer.writeFile("/debug.log", "y");

    const reader = new PgFileSystem({
      db: client,
      workspaceId: WORKSPACE_ID,
      exclude: ["node_modules", "*.log"],
    });

    const entries = await reader.readdir("/");
    expect(entries).toContain("a.txt");
    expect(entries).not.toContain("node_modules");
    expect(entries).not.toContain("debug.log");
  });
});
