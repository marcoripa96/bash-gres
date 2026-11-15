import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TEST_ADAPTERS, createTestSql, resetWorkspace } from "./helpers.js";
import { createDrizzleClient } from "../lib/adapters/drizzle/adapter.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { contentHash, type SqlClient } from "../lib/core/index.js";

const WS = "collect-orphan-blobs-test";
const OTHER_WS = "collect-orphan-blobs-other";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe.each(TEST_ADAPTERS)("collectOrphanBlobs [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;

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
    await resetWorkspace(client, WS);
    await resetWorkspace(client, OTHER_WS);
  });

  async function open(workspaceId = WS, extra: Partial<ConstructorParameters<typeof PgFileSystem>[0]> = {}) {
    const fs = new PgFileSystem({ db: client, workspaceId, historyRetention: "retain", ...extra });
    await fs.init();
    return fs;
  }

  async function blobHashes(workspaceId = WS): Promise<string[]> {
    const r = await client.query<{ h: string }>(
      `SELECT encode(hash, 'hex') AS h FROM fs_blobs WHERE workspace_id = $1 ORDER BY 1`,
      [workspaceId],
    );
    return r.rows.map((x) => x.h);
  }

  /** Make every blob in the workspace look `ms` old. */
  async function age(ms: number, workspaceId = WS): Promise<void> {
    await client.query(
      `UPDATE fs_blobs SET created_at = now() - $2::float8 * interval '1 millisecond'
       WHERE workspace_id = $1`,
      [workspaceId, ms],
    );
  }

  it("deletes blobs no entry references, counting blobs and bytes", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "first");
    await fs.writeFile("/doc.md", "second");
    await fs.writeFile("/gone.md", "removed!");
    await fs.rm("/gone.md");
    // rm in place leaves a tombstone; "first" and "removed!" are unreferenced.
    const r = await fs.collectOrphanBlobs({ minAgeMs: 0 });
    expect(r).toEqual({ blobs: 2, bytes: 5 + 8, complete: true, batches: 1, pending: 0 });
    expect(await blobHashes()).toEqual([contentHash("second")]);
    expect(await fs.readFile("/doc.md")).toBe("second");

    const again = await fs.collectOrphanBlobs({ minAgeMs: 0 });
    expect(again).toEqual({ blobs: 0, bytes: 0, complete: true, batches: 0, pending: 0 });
  });

  it("keeps blobs younger than minAgeMs", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "first");
    await fs.writeFile("/doc.md", "second");
    expect((await fs.collectOrphanBlobs({ minAgeMs: 60_000 })).blobs).toBe(0);
    expect(await blobHashes()).toHaveLength(2);
    await age(120_000);
    expect((await fs.collectOrphanBlobs({ minAgeMs: 60_000 })).blobs).toBe(1);
    expect(await blobHashes()).toEqual([contentHash("second")]);
  });

  it("keeps every blob any version references, retained history included", async () => {
    const main = await open();
    await main.writeFile("/a.md", "a1");
    const fork = await main.fork("fork");
    await fork.writeFile("/a.md", "a-fork");
    await main.writeFile("/a.md", "a2");
    await main.writeFile("/a.md", "a3");
    const r = await main.collectOrphanBlobs({ minAgeMs: 0 });
    // a1 is still read through by... nothing: main overwrote it in place, and
    // the fork wrote its own row. a2 was overwritten in place too.
    expect(r.blobs).toBe(2);
    expect(await main.readFile("/a.md")).toBe("a3");
    expect(await fork.readFile("/a.md")).toBe("a-fork");
  });

  it("collects what removing a versioned folder leaves behind", async () => {
    const root = await open();
    for (const name of ["a1", "a2"]) {
      await root.mkdir(`/artifacts/${name}`, { recursive: true, versioned: true });
      const v = await root.versioned(`/artifacts/${name}`);
      await v.writeFile("/doc.md", `${name} v1`);
      await v.writeFile("/doc.md", `${name} v2`);
      await v.writeFile("/data.json", `{"n":"${name}"}`);
    }
    await root.writeFile("/keep.md", "keep");
    await root.rm("/artifacts/a1", { recursive: true, deleteVersionRoot: true });
    await root.rm("/artifacts/a2", { recursive: true, deleteVersionRoot: true });
    expect((await blobHashes()).length).toBeGreaterThan(1);
    const r = await root.collectOrphanBlobs({ minAgeMs: 0 });
    expect(r.complete).toBe(true);
    expect(await blobHashes()).toEqual([contentHash("keep")]);
    expect(await root.readFile("/keep.md")).toBe("keep");
  });

  it("works in batches", async () => {
    const fs = await open();
    for (let i = 0; i < 5; i++) await fs.writeFile("/doc.md", `v${i}`);
    await fs.writeFile("/doc.md", "final");
    const r = await fs.collectOrphanBlobs({ minAgeMs: 0, batchSize: 2 });
    expect(r).toMatchObject({ blobs: 5, batches: 3, complete: true });
  });

  it("removes the chunks with their blob", async () => {
    const fs = await open(WS, { chunking: {} });
    await fs.writeFile("/doc.md", "# A\n\nfirst\n");
    await fs.writeFile("/doc.md", "# B\n\nsecond\n");
    const chunks = async () =>
      Number(
        (
          await client.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM fs_blob_chunks WHERE workspace_id = $1`,
            [WS],
          )
        ).rows[0]!.n,
      );
    const before = await chunks();
    await fs.collectOrphanBlobs({ minAgeMs: 0 });
    expect(await chunks()).toBeLessThan(before);
    expect((await fs.readFileChunks("/doc.md")).length).toBeGreaterThan(0);
  });

  it("leaves other workspaces alone", async () => {
    const a = await open(WS);
    const b = await open(OTHER_WS);
    await b.writeFile("/x.md", "b1");
    await b.writeFile("/x.md", "b2");
    await a.writeFile("/x.md", "a1");
    await a.collectOrphanBlobs({ minAgeMs: 0 });
    expect(await blobHashes(OTHER_WS)).toHaveLength(2);
  });

  it("reports complete: false while a write transaction holds the workspace", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "first");
    await fs.writeFile("/doc.md", "second");
    const g = gate();
    const started = gate();
    const holder = fs.transaction(async (tx) => {
      await tx.readFile("/doc.md");
      started.open();
      await g.wait;
    });
    await started.wait;
    const t0 = Date.now();
    const r = await fs.collectOrphanBlobs({ minAgeMs: 0, lockTimeoutMs: 200 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(r).toEqual({ blobs: 0, bytes: 0, complete: false, batches: 0, pending: 1 });
    g.open();
    await holder;
    expect(await fs.collectOrphanBlobs({ minAgeMs: 0 })).toMatchObject({ blobs: 1, complete: true });
  });

  it("never deletes an orphaned blob a write in flight is re-using", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "old text");
    await fs.writeFile("/doc.md", "new text");
    await age(3_600_000); // "old text" is an old orphan now
    const g = gate();
    const written = gate();
    // An undo: the writer stores the old content again and has not committed.
    const holder = fs.transaction(async (tx) => {
      await tx.writeFile("/doc.md", "old text");
      written.open();
      await g.wait;
    });
    await written.wait;
    let settled = false;
    const collecting = fs
      .collectOrphanBlobs({ minAgeMs: 60_000, lockTimeoutMs: 10_000 })
      .finally(() => (settled = true));
    await sleep(300);
    expect(settled).toBe(false);
    g.open();
    await holder;
    const r = await collecting;
    expect(r.complete).toBe(true);
    expect(await fs.readFile("/doc.md")).toBe("old text");
    expect(await blobHashes()).toContain(contentHash("old text"));
  });

  it("never deletes an orphaned blob the fast path re-uses meanwhile", async () => {
    for (let round = 0; round < 10; round++) {
      await resetWorkspace(client, WS);
      const fs = await open();
      await fs.writeFile("/doc.md", "A");
      await fs.writeFile("/doc.md", "B");
      await age(3_600_000);
      await Promise.all([
        fs.writeFile("/doc.md", "A"),
        fs.collectOrphanBlobs({ minAgeMs: 60_000 }),
      ]);
      expect(await fs.readFile("/doc.md")).toBe("A");
    }
  });

  it("older cleanups leave freed blobs to the collector while another write transaction is open", async () => {
    const root = await open();
    await root.writeFile("/keep.md", "keep");
    await root.mkdir("/artifacts/a1", { recursive: true, versioned: true });
    const a1 = await root.versioned("/artifacts/a1");
    await a1.writeFile("/doc.md", "a1 doc");
    const g = gate();
    const started = gate();
    const other = await open();
    const holder = other.transaction(async (tx) => {
      await tx.readFile("/keep.md");
      started.open();
      await g.wait;
    });
    await started.wait;
    await root.rm("/artifacts/a1", { recursive: true, deleteVersionRoot: true });
    expect(await blobHashes()).toContain(contentHash("a1 doc"));
    g.open();
    await holder;
    await root.collectOrphanBlobs({ minAgeMs: 0 });
    expect(await blobHashes()).toEqual([contentHash("keep")]);

    // With no other write transaction open, rm frees its blobs itself.
    await root.mkdir("/artifacts/a2", { recursive: true, versioned: true });
    const a2 = await root.versioned("/artifacts/a2");
    await a2.writeFile("/doc.md", "a2 doc");
    await root.rm("/artifacts/a2", { recursive: true, deleteVersionRoot: true });
    expect(await blobHashes()).toEqual([contentHash("keep")]);
  });

  it("is EPERM on a read-only handle and refused inside fs.transaction()", async () => {
    const fs = await open();
    await fs.writeFile("/doc.md", "first");
    await fs.writeFile("/doc.md", "second");
    const ro = new PgFileSystem({ db: client, workspaceId: WS, permissions: { read: true, write: false } });
    await expect(ro.collectOrphanBlobs({ minAgeMs: 0 })).rejects.toMatchObject({ code: "EPERM" });
    await expect(
      fs.transaction((tx) => tx.collectOrphanBlobs({ minAgeMs: 0 })),
    ).rejects.toThrow(/cannot run inside a transaction/);
    await expect(fs.collectOrphanBlobs({ minAgeMs: -1 })).rejects.toThrow(/minAgeMs/);
    expect(await blobHashes()).toHaveLength(2);
  });
});

describe("collectOrphanBlobs in a caller's transaction", () => {
  const sql = createTestSql();
  const db = drizzle(sql);
  const plain = createDrizzleClient(db);

  beforeAll(async () => {
    await ensureSetup();
  });

  afterAll(async () => {
    await sql.end();
  });

  it("refuses to run on a handle built on a Drizzle transaction", async () => {
    await resetWorkspace(plain, WS);
    const fs = new PgFileSystem({ db: plain, workspaceId: WS });
    await fs.init();
    await fs.writeFile("/doc.md", "first");
    await fs.writeFile("/doc.md", "second");
    await db.transaction(async (tx) => {
      const inTx = new PgFileSystem({ db: createDrizzleClient(tx), workspaceId: WS });
      await expect(inTx.collectOrphanBlobs({ minAgeMs: 0 })).rejects.toThrow(
        /cannot run inside a transaction/,
      );
    });
    // Outside the transaction the same client works.
    expect((await fs.collectOrphanBlobs({ minAgeMs: 0 })).blobs).toBe(1);
  });
});
