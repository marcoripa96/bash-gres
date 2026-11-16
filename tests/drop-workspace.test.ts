import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TEST_ADAPTERS, createTestSql, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { dropWorkspace, FsError, type SqlClient } from "../lib/core/index.js";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { dropWorkspace as drizzleDropWorkspace } from "../lib/adapters/drizzle/index.js";

const WS = "drop-workspace-test";
const OTHER_WS = "drop-workspace-other";

const TABLES = [
  "fs_version_roots",
  "fs_versions",
  "version_ancestors",
  "fs_version_merges",
  "fs_entries",
  "fs_blobs",
  "fs_blob_chunks",
  "fs_chunk_embeddings",
] as const;

const GONE = /does not exist in workspace/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Wait until at least `n` sessions are queued on an advisory lock (the blob
 * guard, in these tests), instead of sleeping and hoping they got there.
 */
async function waitForLockWaiters(client: SqlClient, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await client.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (Number(r.rows[0]?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock waiters`);
    await sleep(10);
  }
}

/** A promise's settled value or error, without rejecting. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function rowCounts(client: SqlClient, workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const r = await client.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM ${table} WHERE workspace_id = $1`,
      [workspaceId],
    );
    out[table] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

const EMPTY = Object.fromEntries(TABLES.map((t) => [t, 0]));

async function clearWorkspace(client: SqlClient, workspaceId: string): Promise<void> {
  await client.query(`DELETE FROM fs_blob_chunks WHERE workspace_id = $1`, [workspaceId]);
  await client.query(`DELETE FROM fs_chunk_embeddings WHERE workspace_id = $1`, [workspaceId]);
  await resetWorkspace(client, workspaceId);
}

/**
 * A workspace with every kind of row: `/` and two versioned folders,
 * forks, a merge parent, a frozen + materialized version, a
 * deleted-but-retained one, chunks and a cached embedding.
 */
async function populate(client: SqlClient, workspaceId: string): Promise<PgFileSystem> {
  const root = new PgFileSystem({
    db: client,
    workspaceId,
    historyRetention: "retain",
    chunking: true,
  });
  await root.init();
  await root.writeFile("/readme.md", "# Readme\n\nhello\n");
  await root.writeFile("/readme.md", "# Readme\n\nhello again\n");

  // Two sibling forks, so the merge records a merge parent (a fork of the
  // destination would be its descendant and record none).
  const feat = await root.fork("feat");
  const work = await root.fork("work");
  await feat.writeFile("/feat.md", "# Feat\n\nwork\n");
  await feat.freeze();
  await work.writeFile("/work-only.md", "work");
  await work.merge("feat");

  await root.mkdir("/databases/1", { recursive: true, versioned: true });
  const db = await root.versioned("/databases/1");
  await db.writeFile("/knowledge.md", "# K\n\nfacts\n");

  await root.mkdir("/artifacts/2", { recursive: true, versioned: true });
  const art = await root.versioned("/artifacts/2");
  await art.writeFile("/a.json", '{"v":1}');
  const draft = await art.fork("draft");
  await draft.writeFile("/a.json", '{"v":2}');
  await draft.promoteTo("main", { dropPrevious: true, freeze: true, materialize: true });

  await client.query(
    `INSERT INTO fs_chunk_embeddings (workspace_id, content_hash, embedding)
     VALUES ($1, '\\x01'::bytea, '[1,2,3]')`,
    [workspaceId],
  );
  return root;
}

describe.each(TEST_ADAPTERS)("dropWorkspace [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
    // fs_chunk_embeddings exists only under vector search.
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
  });

  afterAll(async () => {
    await clearWorkspace(client, WS);
    await clearWorkspace(client, OTHER_WS);
    await teardown();
  });

  beforeEach(async () => {
    await clearWorkspace(client, WS);
    await clearWorkspace(client, OTHER_WS);
  });

  it("removes every row of the workspace and counts them", async () => {
    await populate(client, WS);
    await populate(client, OTHER_WS);
    const before = await rowCounts(client, WS);
    const other = await rowCounts(client, OTHER_WS);
    for (const table of TABLES) expect(before[table], table).toBeGreaterThan(0);
    const bytes = await client.query<{ n: number | string }>(
      `SELECT COALESCE(sum(size_bytes), 0) AS n FROM fs_blobs WHERE workspace_id = $1`,
      [WS],
    );

    const r = await dropWorkspace(client, WS);
    expect(r).toEqual({
      versionRoots: before.fs_version_roots,
      versions: before.fs_versions,
      versionAncestors: before.version_ancestors,
      versionMerges: before.fs_version_merges,
      entries: before.fs_entries,
      blobs: before.fs_blobs,
      bytes: Number(bytes.rows[0]!.n),
      chunks: before.fs_blob_chunks,
      chunkEmbeddings: before.fs_chunk_embeddings,
    });
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
    expect(await rowCounts(client, OTHER_WS)).toEqual(other);
  });

  it("is idempotent: a missing or already dropped workspace returns zeros", async () => {
    const zeros = {
      versionRoots: 0, versions: 0, versionAncestors: 0, versionMerges: 0,
      entries: 0, blobs: 0, bytes: 0, chunks: 0, chunkEmbeddings: 0,
    };
    expect(await dropWorkspace(client, "drop-workspace-never-created")).toEqual(zeros);
    await populate(client, WS);
    expect((await dropWorkspace(client, WS)).entries).toBeGreaterThan(0);
    expect(await dropWorkspace(client, WS)).toEqual(zeros);
  });

  it("commits or rolls back with the caller's transaction", async () => {
    await populate(client, WS);
    const before = await rowCounts(client, WS);

    await expect(
      client.transaction(async (tx) => {
        await dropWorkspace(tx, WS);
        expect(await rowCounts(tx, WS)).toEqual(EMPTY);
        throw new Error("tenant delete failed");
      }),
    ).rejects.toThrow("tenant delete failed");
    expect(await rowCounts(client, WS)).toEqual(before);

    await client.transaction((tx) => dropWorkspace(tx, WS));
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
  });

  it("puts back the caller's app.workspace_id and statement_timeout", async () => {
    await populate(client, WS);
    const after = await client.transaction(async (tx) => {
      await tx.query(
        `SELECT set_config('app.workspace_id', $1, true),
                set_config('statement_timeout', '1234', true)`,
        [WS],
      );
      await dropWorkspace(tx, WS);
      const r = await tx.query<{ ws: string; st: string }>(
        `SELECT current_setting('app.workspace_id') AS ws,
                current_setting('statement_timeout') AS st`,
      );
      return r.rows[0]!;
    });
    expect(after).toEqual({ ws: WS, st: "1234ms" });
  });

  it("refuses a transaction scoped to another workspace", async () => {
    await populate(client, WS);
    const before = await rowCounts(client, WS);
    await expect(
      client.transaction(async (tx) => {
        await tx.query(`SELECT set_config('app.workspace_id', $1, true)`, [OTHER_WS]);
        await dropWorkspace(tx, WS);
      }),
    ).rejects.toThrow(/scoped to another workspace/);
    expect(await rowCounts(client, WS)).toEqual(before);
  });

  it("refuses REPEATABLE READ and SERIALIZABLE", async () => {
    await populate(client, WS);
    const before = await rowCounts(client, WS);
    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      await expect(
        client.transaction(async (tx) => {
          await tx.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
          await dropWorkspace(tx, WS);
        }),
      ).rejects.toThrow(/needs READ COMMITTED/);
    }
    expect(await rowCounts(client, WS)).toEqual(before);
  });

  it("rejects an empty workspace id", async () => {
    await expect(dropWorkspace(client, "")).rejects.toThrow(/non-empty/);
  });

  it("a handle open on the dropped workspace reads nothing, writes nothing, and init() recreates it empty", async () => {
    const fs = await populate(client, WS);
    const db = await fs.versioned("/databases/1");
    await dropWorkspace(client, WS);

    // Reads with ids cached before the drop find nothing.
    await expect(fs.readFile("/readme.md")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.exists("/")).toBe(false);

    // Every write path fails the way a never-created workspace does and
    // leaves no row; the handle forgets its cached version on the way.
    await expect(fs.writeFile("/new.md", "x")).rejects.toThrow(GONE);
    await expect(fs.writeFile("/deep/dir/new.md", "x")).rejects.toThrow(GONE);
    await expect(db.writeFile("/knowledge.md", "y")).rejects.toThrow(GONE);
    expect(await rowCounts(client, WS)).toEqual(EMPTY);

    const fresh = new PgFileSystem({ db: client, workspaceId: WS });
    for (const handle of [fs, fresh]) {
      await expect(handle.readFile("/readme.md")).rejects.toThrow(GONE);
      await expect(handle.writeFile("/x.md", "x")).rejects.toThrow(GONE);
    }
    expect(await rowCounts(client, WS)).toEqual(EMPTY);

    await fs.init();
    expect(await fs.readdir("/")).toEqual([]);
    await fs.writeFile("/again.md", "again");
    expect(await fs.readFile("/again.md")).toBe("again");
    expect(await fresh.readFile("/again.md")).toBe("again");
  });

  it("stale handles fail on every write path without leaving rows", async () => {
    await populate(client, WS);
    const plain = new PgFileSystem({ db: client, workspaceId: WS, historyRetention: "retain" });
    await plain.init();
    await plain.writeFile("/warm.md", "warm"); // fast path armed
    const quota = new PgFileSystem({ db: client, workspaceId: WS, maxWorkspaceBytes: 1e9 });
    await quota.init();
    await dropWorkspace(client, WS);

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["writeFile fast", () => plain.writeFile("/f.md", "f")],
      ["writeFile tx", () => quota.writeFile("/t.md", "t")],
      ["writeFileWithBase", () => quota.writeFileWithBase("/w.md", "w", { base: null })],
      ["mkdir -p", () => quota.mkdir("/m/n", { recursive: true })],
      ["transaction", () => quota.transaction((tx) => tx.writeFile("/x.md", "x"))],
      ["fork", () => quota.fork("branch")],
      ["freeze", () => plain.freeze()],
    ];
    for (const [label, run] of attempts) {
      const out = await settle(run());
      expect(out.ok, label).toBe(false);
      if (!out.ok) {
        const msg = messageOf(out.error);
        // A path that has to be resolved first (mkdir) sees an empty tree.
        expect(GONE.test(msg) || (out.error instanceof FsError && out.error.code === "ENOENT"), `${label}: ${msg}`).toBe(true);
      }
    }
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
  });

  it("works with a Drizzle transaction through bash-gres/drizzle", async () => {
    const sql = createTestSql();
    try {
      const db = drizzle(sql);
      await populate(client, WS);
      await expect(
        db.transaction(async (tx) => {
          await drizzleDropWorkspace(tx, WS);
          tx.rollback();
        }),
      ).rejects.toThrow();
      expect((await rowCounts(client, WS)).fs_entries).toBeGreaterThan(0);
      const r = await db.transaction((tx) => drizzleDropWorkspace(tx, WS));
      expect(r.entries).toBeGreaterThan(0);
      expect(await rowCounts(client, WS)).toEqual(EMPTY);
    } finally {
      await sql.end();
    }
  });
});

describe("dropWorkspace against concurrent writers", () => {
  let sql: ReturnType<typeof createTestSql>;
  let client: SqlClient;

  beforeAll(async () => {
    await ensureSetup();
    sql = createTestSql();
    client = createPostgresClient(sql);
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
  });

  afterAll(async () => {
    await clearWorkspace(client, WS);
    await sql.end();
  });

  beforeEach(async () => {
    await clearWorkspace(client, WS);
  });

  async function open(extra: Partial<ConstructorParameters<typeof PgFileSystem>[0]> = {}) {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, historyRetention: "retain", ...extra });
    await fs.init();
    return fs;
  }

  it("waits for an open write transaction, then removes what it wrote", async () => {
    const fs = await open();
    await fs.writeFile("/a.md", "a");
    const g = gate();
    const written = gate();
    const holder = fs.transaction(async (tx) => {
      await tx.writeFile("/b.md", "b");
      written.open();
      await g.wait;
    });
    await written.wait;

    let done = false;
    const drop = dropWorkspace(client, WS).then((r) => ((done = true), r));
    await waitForLockWaiters(client, 1);
    expect(done).toBe(false);
    g.open();
    await holder;
    const r = await drop;
    expect(r.entries).toBe(3); // "/", a.md, b.md
    expect(r.blobs).toBe(2);
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
  });

  it("writes that queue behind the drop fail once it commits and leave nothing", async () => {
    const fast = await open();
    await fast.writeFile("/a.md", "a");
    const quota = await open({ maxWorkspaceBytes: 1e9 }); // transactional path
    const g = gate();
    const dropped = gate();
    const dropper = client.transaction(async (tx) => {
      const r = await dropWorkspace(tx, WS);
      dropped.open();
      await g.wait;
      return r;
    });
    await dropped.wait;

    const writes = [
      fast.writeFile("/x.md", "x"),
      fast.writeFile("/a.md", "a2"),
      fast.writeFileWithBase("/a.md", "a3", { base: { content: "a" } }),
      quota.writeFile("/d/e/f.md", "y"),
      quota.mkdir("/m/n", { recursive: true }),
      quota.rm("/a.md"),
    ].map(settle);
    await waitForLockWaiters(client, writes.length);
    g.open();
    await dropper;

    for (const out of await Promise.all(writes)) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        const e = out.error;
        const msg = messageOf(e);
        expect(GONE.test(msg) || (e instanceof FsError && e.code === "ENOENT"), msg).toBe(true);
      }
    }
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
  });

  it("collectOrphanBlobs backs off while a drop holds the workspace", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "first");
    await fs.writeFile("/doc.md", "second");
    const g = gate();
    const dropped = gate();
    const dropper = client.transaction(async (tx) => {
      await dropWorkspace(tx, WS);
      dropped.open();
      await g.wait;
    });
    await dropped.wait;
    const r = await fs.collectOrphanBlobs({ minAgeMs: 0, lockTimeoutMs: 200 });
    expect(r).toMatchObject({ blobs: 0, complete: false });
    g.open();
    await dropper;
    expect(await fs.collectOrphanBlobs({ minAgeMs: 0 })).toMatchObject({ blobs: 0, complete: true });
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
  });

  it("waits for a collector batch that holds the guard", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "x");
    const g = gate();
    const locked = gate();
    // What collectOrphanBlobs holds for one batch: the guard, exclusive.
    const batch = client.transaction(async (tx) => {
      await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext($1), -2)`, [WS]);
      locked.open();
      await g.wait;
    });
    await locked.wait;
    let done = false;
    const drop = dropWorkspace(client, WS).then((r) => ((done = true), r));
    await waitForLockWaiters(client, 1);
    expect(done).toBe(false);
    g.open();
    await batch;
    expect((await drop).entries).toBe(2);
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
  });

  it("races writers and the collector without deadlocks or leftover rows", async () => {
    for (let round = 0; round < 6; round++) {
      await clearWorkspace(client, WS);
      const handles = [
        await open(),
        await open({ maxWorkspaceBytes: 1e9 }),
        await open({ chunking: true }),
      ];
      await handles[0]!.writeFile("/seed.md", "seed");
      const art = new PgFileSystem({ db: client, workspaceId: WS, historyRetention: "retain" });
      await art.mkdir("/artifacts/1", { recursive: true, versioned: true });
      const artFs = await art.versioned("/artifacts/1");
      await artFs.writeFile("/a.json", "{}");

      let stop = false;
      const errors: unknown[] = [];
      const loop = async (i: number, fs: PgFileSystem) => {
        for (let n = 0; !stop; n++) {
          const ops = [
            () => fs.writeFile(`/w${i}/f${n % 5}.md`, `# ${i}-${n}\n\nbody ${n}\n`),
            () => fs.writeFile("/seed.md", `seed ${i} ${n}`),
            () => fs.writeFileWithBase(`/b${i}.md`, `v${n}`, { base: null, resolve: () => ({ content: `m${n}` }) }),
            () => fs.mkdir(`/d${i}/${n % 3}`, { recursive: true }),
            () => fs.rm(`/w${i}`, { recursive: true, force: true }),
            () => fs.cp("/seed.md", `/copy${i}.md`),
          ];
          const out = await settle(ops[n % ops.length]!());
          if (!out.ok) errors.push(out.error);
          await sleep(Math.random() * 3);
        }
      };
      const loops = [
        ...handles.map((h, i) => loop(i, h)),
        loop(9, artFs),
        (async () => {
          while (!stop) {
            const out = await settle(handles[0]!.collectOrphanBlobs({ minAgeMs: 0, lockTimeoutMs: 20 }));
            if (!out.ok) errors.push(out.error);
            await sleep(5);
          }
        })(),
      ];
      await sleep(30 + Math.random() * 60);
      const r = await dropWorkspace(client, WS);
      expect(r.versionRoots).toBe(2);
      await sleep(50);
      stop = true;
      await Promise.all(loops);

      for (const e of errors) {
        const msg = messageOf(e);
        expect(msg).not.toMatch(/deadlock/i);
        const expected =
          GONE.test(msg) ||
          // A versioned-folder handle, once it has forgotten its version,
          // finds no root: what a never-created versioned folder answers.
          (e instanceof FsError && ["ENOENT", "EEXIST", "ENOTDIR", "ENOTVERSIONED"].includes(e.code)) ||
          (e instanceof Error && e.name === "FsWriteConflictError");
        expect(expected, msg).toBe(true);
      }
      expect(await rowCounts(client, WS), `round ${round}`).toEqual(EMPTY);
    }
  });
});

describe("dropWorkspace under RLS", () => {
  const ROLE = "bashgres_drop_rls_test";
  const RLS_TABLES = TABLES;
  let sql: ReturnType<typeof createTestSql>;
  let client: SqlClient;

  beforeAll(async () => {
    await ensureSetup();
    sql = createTestSql();
    client = createPostgresClient(sql);
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
    await clearWorkspace(client, WS);
    await clearWorkspace(client, OTHER_WS);
    await populate(client, WS);
    await populate(client, OTHER_WS);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS;
        END IF;
      END $$;
    `);
    for (const table of RLS_TABLES) {
      // Exactly what the drop needs: SELECT (for RETURNING) and DELETE.
      await client.query(`GRANT SELECT, DELETE ON ${table} TO ${ROLE}`);
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
    }
  });

  afterAll(async () => {
    try {
      for (const table of RLS_TABLES) {
        await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        await client.query(`REVOKE ALL ON ${table} FROM ${ROLE}`).catch(() => undefined);
      }
      await client.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    } finally {
      await clearWorkspace(client, WS);
      await clearWorkspace(client, OTHER_WS);
      await sql.end();
    }
  });

  it("a role scoped to another tenant cannot drop this one", async () => {
    const before = await rowCounts(client, WS);
    await expect(
      client.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${ROLE}`);
        await tx.query(`SELECT set_config('app.workspace_id', $1, true)`, [OTHER_WS]);
        await dropWorkspace(tx, WS);
      }),
    ).rejects.toThrow(/scoped to another workspace/);
    expect(await rowCounts(client, WS)).toEqual(before);
  });

  it("a tenant-scoped role drops its own workspace and nothing else", async () => {
    const other = await rowCounts(client, OTHER_WS);
    const r = await client.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${ROLE}`);
      // Scoped to its own tenant (or not scoped at all: the drop scopes itself).
      await tx.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
      return dropWorkspace(tx, WS);
    });
    expect(r.entries).toBeGreaterThan(0);
    expect(r.chunkEmbeddings).toBe(1);
    expect(await rowCounts(client, WS)).toEqual(EMPTY);
    expect(await rowCounts(client, OTHER_WS)).toEqual(other);
  });
});
