import { describe, it, expect, beforeAll, afterEach } from "vitest";
import postgres from "postgres";
import { createPostgresClient, PgFileSystem } from "./index.js";
import { setup } from "../../core/setup.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const WORKSPACE_ID = "postgres-adapter-prepare-test";

/** One connection, so pg_prepared_statements shows this client's statements. */
function oneConnection(options: postgres.Options<{}> = {}): postgres.Sql {
  return postgres(TEST_DB_URL, { onnotice: () => {}, max: 1, ...options });
}

async function preparedStatements(sql: postgres.Sql): Promise<string[]> {
  // No params: runs over the simple protocol, so it isn't prepared itself.
  // postgres.js prepares its own array-type lookup on connect; skip it.
  const rows = await sql.unsafe<{ statement: string }[]>(
    "SELECT statement FROM pg_prepared_statements",
  );
  return rows
    .map((r) => r.statement)
    .filter((s) => !s.includes("pg_catalog.pg_type"));
}

describe("postgres.js adapter: prepare option", () => {
  const open: postgres.Sql[] = [];
  const connect = (options?: postgres.Options<{}>) => {
    const sql = oneConnection(options);
    open.push(sql);
    return sql;
  };

  beforeAll(async () => {
    const sql = connect();
    await setup(createPostgresClient(sql), {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
    for (const table of [
      "fs_entries",
      "version_ancestors",
      "fs_versions",
      "fs_version_roots",
      "fs_blobs",
    ]) {
      await sql.unsafe(`DELETE FROM ${table} WHERE workspace_id = $1`, [
        WORKSPACE_ID,
      ]);
    }
    await new PgFileSystem({ db: sql, workspaceId: WORKSPACE_ID }).init();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((sql) => sql.end()));
  });

  it("does not prepare by default", async () => {
    const sql = connect();
    const fs = new PgFileSystem({ db: sql, workspaceId: WORKSPACE_ID });
    await fs.exists("/missing.txt");
    expect(await preparedStatements(sql)).toEqual([]);
  });

  it("prepares filesystem queries when enabled", async () => {
    const sql = connect();
    const fs = new PgFileSystem({
      db: sql,
      workspaceId: WORKSPACE_ID,
      prepare: true,
    });
    await fs.writeFile("/a.txt", "alpha");
    expect(await fs.readFile("/a.txt")).toBe("alpha");
    const before = await preparedStatements(sql);
    expect(before.length).toBeGreaterThan(0);

    // Repeating the same calls reuses the cached statements.
    await fs.readFile("/a.txt");
    await fs.readFile("/a.txt");
    expect((await preparedStatements(sql)).length).toBe(before.length);
  });

  it("applies inside transactions", async () => {
    const sql = connect();
    const client = createPostgresClient(sql, { prepare: true });
    await client.transaction((tx) => tx.query("SELECT $1::int AS n", [1]));
    expect(await preparedStatements(sql)).toContain("SELECT $1::int AS n");
  });

  it("leaves statements with more than 32 params unprepared", async () => {
    const sql = connect();
    const client = createPostgresClient(sql, { prepare: true });
    const params = Array.from({ length: 33 }, (_, i) => i);
    const list = params.map((_, i) => `($${i + 1}::int)`).join(", ");
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (VALUES ${list}) AS v(x)`,
      params,
    );
    expect(r.rows[0]!.n).toBe(33);
    expect(await preparedStatements(sql)).toEqual([]);
  });

  it("never overrides a connection created with prepare: false", async () => {
    const sql = connect({ prepare: false });
    const client = createPostgresClient(sql, { prepare: true });
    await client.query("SELECT $1::int AS n", [1]);
    expect(await preparedStatements(sql)).toEqual([]);
  });

  it("is inherited by forks", async () => {
    const sql = connect();
    const fs = new PgFileSystem({
      db: sql,
      workspaceId: WORKSPACE_ID,
      prepare: true,
    });
    const child = await fs.fork("prepare-child");
    const before = await preparedStatements(sql);
    await child.readdirWithFileTypes("/");
    expect((await preparedStatements(sql)).length).toBeGreaterThan(
      before.length,
    );
    await fs.deleteVersion("prepare-child");
  });
});
