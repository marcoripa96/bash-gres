import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type postgres from "postgres";
import pg from "pg";
import { ensureSetup } from "./global-setup.js";
import { createTestSql, resetWorkspace } from "./helpers.js";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { createNodePgClient } from "../lib/adapters/node-postgres/index.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { FsError, type SqlClient } from "../lib/core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const RLS_TABLES = [
  "fs_versions",
  "version_ancestors",
  "fs_entries",
  "fs_blobs",
] as const;

describe("production failure modes", () => {
  let sql: postgres.Sql;
  let client: SqlClient;

  beforeAll(async () => {
    await ensureSetup();
    sql = createTestSql();
    client = createPostgresClient(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  // --------------------------------------------------------------------------
  // 1. Concurrent writers
  // --------------------------------------------------------------------------

  describe("concurrent writers", () => {
    const ws = "ws-concurrent";

    beforeEach(async () => {
      await resetWorkspace(client, ws);
    });

    it("Promise.all of N writes to distinct paths lands every row", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: ws });
      await fs.init();
      const N = 25;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fs.writeFile(`/file-${i}.txt`, `content-${i}`),
        ),
      );

      for (let i = 0; i < N; i++) {
        expect(await fs.readFile(`/file-${i}.txt`)).toBe(`content-${i}`);
      }
    });

    it("concurrent writes to the same path settle on one of the inputs (no corruption)", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: ws });
      await fs.init();
      const values = ["a", "b", "c", "d", "e", "f", "g", "h"];

      await Promise.all(values.map((v) => fs.writeFile("/race.txt", v)));

      const final = await fs.readFile("/race.txt");
      expect(values).toContain(final);
    });

    it("concurrent recursive mkdir of the same path is idempotent", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: ws });
      await fs.init();

      await Promise.all(
        Array.from({ length: 12 }, () =>
          fs.mkdir("/a/b/c/d/e", { recursive: true }),
        ),
      );

      const stat = await fs.stat("/a/b/c/d/e");
      expect(stat.isDirectory).toBe(true);
    });

    it("concurrent writes + reads on disjoint paths do not interfere", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: ws });
      await fs.init();

      // Seed
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          fs.writeFile(`/seed-${i}.txt`, `seed-${i}`),
        ),
      );

      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(fs.writeFile(`/new-${i}.txt`, `new-${i}`));
        ops.push(fs.readFile(`/seed-${i}.txt`));
      }
      const results = await Promise.all(ops);

      for (let i = 0; i < 10; i++) {
        expect(results[i * 2 + 1]).toBe(`seed-${i}`);
      }
      for (let i = 0; i < 10; i++) {
        expect(await fs.readFile(`/new-${i}.txt`)).toBe(`new-${i}`);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. RLS workspace isolation
  // --------------------------------------------------------------------------

  describe("RLS workspace isolation", () => {
    // The test database is owned by `postgres` (a superuser). Superusers bypass
    // RLS entirely, so to actually exercise the policy we run RLS-sensitive
    // queries under a dedicated NOBYPASSRLS role via `SET LOCAL ROLE`.
    const wsA = "ws-rls-a";
    const wsB = "ws-rls-b";
    const ROLE = "bashgres_rls_test";

    async function setRls(enable: boolean): Promise<void> {
      for (const table of RLS_TABLES) {
        if (enable) {
          await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
          await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
          await client.query(`
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE tablename = '${table}' AND policyname = 'workspace_isolation'
              ) THEN
                CREATE POLICY workspace_isolation ON ${table} FOR ALL
                  USING (workspace_id = current_setting('app.workspace_id', true))
                  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
              END IF;
            END $$;
          `);
        } else {
          await client.query(
            `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`,
          );
          await client.query(
            `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
          );
        }
      }
    }

    beforeAll(async () => {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
            CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS;
          END IF;
        END $$;
      `);
      for (const table of RLS_TABLES) {
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${ROLE}`);
      }

      await resetWorkspace(client, wsA);
      await resetWorkspace(client, wsB);
      await setRls(true);

      const fsA = new PgFileSystem({ db: client, workspaceId: wsA });
      const fsB = new PgFileSystem({ db: client, workspaceId: wsB });
      await fsA.init();
      await fsB.init();
      await fsA.writeFile("/secret.txt", "from A");
      await fsB.writeFile("/public.txt", "from B");
    });

    afterAll(async () => {
      try {
        await setRls(false);
      } finally {
        await resetWorkspace(client, wsA);
        await resetWorkspace(client, wsB);
        // Drop the role last so tests can be re-run idempotently.
        for (const table of RLS_TABLES) {
          await client
            .query(`REVOKE ALL ON ${table} FROM ${ROLE}`)
            .catch(() => undefined);
        }
        await client.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
      }
    });

    /** Run a SELECT under the NOBYPASSRLS role with the given GUC. */
    async function selectAsRole<T>(
      gucWorkspace: string | null,
      query: string,
      params: (string | number)[] = [],
    ): Promise<T[]> {
      const result = await client.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${ROLE}`);
        if (gucWorkspace !== null) {
          await tx.query("SELECT set_config('app.workspace_id', $1, true)", [
            gucWorkspace,
          ]);
        }
        return tx.query<T>(query, params);
      });
      return result.rows;
    }

    it("a query with no app.workspace_id GUC sees no rows", async () => {
      const rows = await selectAsRole<{ workspace_id: string }>(
        null,
        "SELECT workspace_id FROM fs_entries",
      );
      expect(rows.length).toBe(0);
    });

    it("a transaction with the wrong GUC cannot read another workspace's fs_entries", async () => {
      const rows = await selectAsRole<{ count: string }>(
        wsB,
        "SELECT count(*)::text AS count FROM fs_entries WHERE workspace_id = $1",
        [wsA],
      );
      expect(rows[0]?.count).toBe("0");
    });

    it("a transaction with the wrong GUC cannot read another workspace's fs_blobs", async () => {
      const rows = await selectAsRole<{ count: string }>(
        wsB,
        "SELECT count(*)::text AS count FROM fs_blobs WHERE workspace_id = $1",
        [wsA],
      );
      expect(rows[0]?.count).toBe("0");
    });

    it("a transaction with the right GUC sees its own rows", async () => {
      const rows = await selectAsRole<{ count: string }>(
        wsA,
        "SELECT count(*)::text AS count FROM fs_entries WHERE workspace_id = $1",
        [wsA],
      );
      expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    });

    it("an INSERT with workspace_id mismatching the GUC is rejected by WITH CHECK", async () => {
      await expect(
        client.transaction(async (tx) => {
          await tx.query(`SET LOCAL ROLE ${ROLE}`);
          await tx.query("SELECT set_config('app.workspace_id', $1, true)", [
            wsB,
          ]);
          await tx.query(
            "INSERT INTO fs_versions (workspace_id, label) VALUES ($1, $2)",
            [wsA, "smuggled"],
          );
        }),
      ).rejects.toThrow();
    });

    it("PgFileSystem at the application layer cannot see another workspace's files", async () => {
      // Application-layer workspace scoping (the WHERE workspace_id = $1 in
      // every query) — independent of RLS, but worth pinning down.
      const fsB = new PgFileSystem({ db: client, workspaceId: wsB });
      await expect(fsB.readFile("/secret.txt")).rejects.toBeInstanceOf(FsError);
    });
  });

  // --------------------------------------------------------------------------
  // 3. DB disconnect mid-transaction
  // --------------------------------------------------------------------------

  describe("DB disconnect mid-transaction", () => {
    // Backed by node-postgres because pg.Pool handles a killed PoolClient
    // cleanly (release(true) discards the bad client). postgres.js leaves a
    // null-socket race after pg_terminate_backend that surfaces as an
    // unhandled error on the next event-loop tick.
    const ws = "ws-disconnect";
    let pool: pg.Pool;
    let pgClient: SqlClient;

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: TEST_DB_URL });
      // pg_terminate_backend causes the underlying pg.Client to emit 'error'
      // asynchronously after the in-flight query has already rejected. The
      // pool only listens on idle clients, so without this the event surfaces
      // as an unhandled exception. Attach a noop listener per physical
      // connection.
      pool.on("connect", (client) => {
        client.on("error", () => undefined);
      });
      pool.on("error", () => undefined);
      pgClient = createNodePgClient(pool);
    });

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await resetWorkspace(client, ws);
    });

    it("backend termination inside a transaction rejects the promise", async () => {
      await expect(
        pgClient.transaction(async (tx) => {
          await tx.query("SELECT pg_terminate_backend(pg_backend_pid())");
          // Unreachable: the backend is dead.
          await tx.query("SELECT 1");
        }),
      ).rejects.toThrow();
    });

    it("rolled-back work is not visible after disconnect", async () => {
      await expect(
        pgClient.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO fs_versions (workspace_id, label) VALUES ($1, $2)",
            [ws, "killme"],
          );
          await tx.query("SELECT pg_terminate_backend(pg_backend_pid())");
        }),
      ).rejects.toThrow();

      // Verify rollback persisted nothing — query via the original client so
      // we exercise both connections.
      const r = await client.query(
        "SELECT 1 FROM fs_versions WHERE workspace_id = $1 AND label = $2",
        [ws, "killme"],
      );
      expect(r.rowCount).toBe(0);
    });

    it("client recovers — subsequent operations succeed via a new connection", async () => {
      await pgClient
        .transaction(async (tx) => {
          await tx.query("SELECT pg_terminate_backend(pg_backend_pid())");
        })
        .catch(() => {
          /* expected */
        });

      const fs = new PgFileSystem({ db: pgClient, workspaceId: ws });
      await fs.init();
      await fs.writeFile("/recovered.txt", "ok");
      expect(await fs.readFile("/recovered.txt")).toBe("ok");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Large files (>10 MB)
  // --------------------------------------------------------------------------

  describe("large files (>10 MB)", () => {
    const ws = "ws-large";
    const TWELVE_MB = 12 * 1024 * 1024;
    const TWENTY_MB = 20 * 1024 * 1024;

    beforeEach(async () => {
      await resetWorkspace(client, ws);
    });

    it("round-trips a 12 MB text file", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: ws,
        maxFileSize: TWENTY_MB,
        statementTimeoutMs: 30_000,
      });
      await fs.init();

      // Build 12 MiB of repeating ASCII so we can verify by length + sampling.
      // Use a 1 KiB chunk so it divides 12 MiB cleanly.
      const chunk = "0123456789abcdef".repeat(64); // 1 KiB
      const text = chunk.repeat(TWELVE_MB / chunk.length);
      expect(text.length).toBe(TWELVE_MB);

      await fs.writeFile("/big.txt", text);

      const stat = await fs.stat("/big.txt");
      expect(stat.size).toBe(TWELVE_MB);

      const head = await fs.readFileRange("/big.txt", { offset: 0, limit: 32 });
      expect(head).toBe("0123456789abcdef".repeat(2));

      const tail = await fs.readFileRange("/big.txt", {
        offset: TWELVE_MB - 16,
        limit: 16,
      });
      expect(tail).toBe("0123456789abcdef");

      const full = await fs.readFile("/big.txt");
      expect(full.length).toBe(TWELVE_MB);
      expect(full).toBe(text);
    });

    it("round-trips a 12 MB binary file (byte-exact)", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: ws,
        maxFileSize: TWENTY_MB,
        statementTimeoutMs: 30_000,
      });
      await fs.init();

      const buf = new Uint8Array(TWELVE_MB);
      // Patterned bytes within the printable ASCII range so readFileRange
      // (which decodes UTF-8) round-trips cleanly.
      for (let i = 0; i < TWELVE_MB; i++) buf[i] = 0x41 + (i % 26);

      await fs.writeFile("/big.bin", buf);

      const stat = await fs.stat("/big.bin");
      expect(stat.size).toBe(TWELVE_MB);

      // Sample three windows; each must match the deterministic pattern.
      for (const offset of [0, 1_000_000, TWELVE_MB - 26]) {
        const slice = await fs.readFileRange("/big.bin", { offset, limit: 26 });
        let expected = "";
        for (let i = 0; i < 26; i++) {
          expected += String.fromCharCode(0x41 + ((offset + i) % 26));
        }
        expect(slice).toBe(expected);
      }
    });

    it("rejects a write that exceeds maxFileSize", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: ws,
        maxFileSize: TWELVE_MB,
        statementTimeoutMs: 30_000,
      });
      await fs.init();

      const tooBig = "x".repeat(TWELVE_MB + 1);
      await expect(fs.writeFile("/oversized.txt", tooBig)).rejects.toThrow(
        /too large/i,
      );

      // Verify nothing was persisted under the file's parent.
      await expect(fs.stat("/oversized.txt")).rejects.toBeInstanceOf(FsError);
    });

    it("appendFile fails atomically when crossing maxFileSize", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: ws,
        maxFileSize: TWELVE_MB,
        statementTimeoutMs: 30_000,
      });
      await fs.init();

      const half = "y".repeat(TWELVE_MB - 8);
      await fs.writeFile("/grow.txt", half);

      // 9 bytes pushes us 1 byte over the limit.
      await expect(fs.appendFile("/grow.txt", "123456789")).rejects.toThrow(
        /too large/i,
      );

      const stat = await fs.stat("/grow.txt");
      expect(stat.size).toBe(TWELVE_MB - 8);
    });
  });
});
