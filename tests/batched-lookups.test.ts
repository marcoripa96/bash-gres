import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient, TraceEvent } from "../lib/core/types.js";

const WS = "batched-lookups";

/** resolveEntries' multi-path lookup: what a coalesced batch sends. */
const isBatchQuery = (e: TraceEvent) =>
  e.type === "query" && e.sql.includes("ANY($2::ltree[])");

type Outcome = { ok: unknown } | { err: string };

async function settle(p: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await p };
  } catch (e) {
    return { err: (e as { code?: string }).code ?? String(e) };
  }
}

/** Strip mtime so batched and sequential stats compare structurally. */
function shape(o: Outcome): Outcome {
  if ("ok" in o && o.ok && typeof o.ok === "object") {
    const { mtime: _mtime, ...rest } = o.ok as Record<string, unknown>;
    return { ok: rest };
  }
  return o;
}

describe.each(TEST_ADAPTERS)("batched lookups [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let events: TraceEvent[];
  let fs: PgFileSystem;

  const sqlCount = () => events.filter((e) => e.type === "query").length;

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
    const writer = new PgFileSystem({ db: client, workspaceId: WS });
    await writer.init();
    await writer.mkdir("/d/sub", { recursive: true });
    for (let i = 0; i < 20; i++) await writer.writeFile(`/d/f${i}.txt`, `${i}`);
    await writer.writeFile("/d/secret.log", "hidden");
    await writer.symlink("/d/f1.txt", "/d/link");
    await writer.symlink("/d/nowhere", "/d/broken");
    await writer.symlink("/d/loop-b", "/d/loop-a");
    await writer.symlink("/d/loop-a", "/d/loop-b");
    events = [];
    fs = new PgFileSystem({
      db: client,
      workspaceId: WS,
      exclude: ["*.log"],
      trace: (e) => events.push(e),
    });
  });

  const PATHS = [
    "/d/f0.txt",
    "/d/f1.txt",
    "/d/f1.txt", // duplicate in the same batch
    "/d/sub",
    "/d/missing.txt",
    "/d/secret.log", // excluded
    "/d/link",
    "/d/broken",
    "/d/loop-a",
    "/",
  ];

  it("answers a burst of stats with one query, same results as one at a time", async () => {
    const sequential: Outcome[] = [];
    for (const p of PATHS) sequential.push(shape(await settle(fs.stat(p))));
    events.length = 0;

    const batched = (await Promise.all(PATHS.map((p) => settle(fs.stat(p))))).map(
      shape,
    );

    expect(batched).toEqual(sequential);
    // One lookup for the burst, plus the per-call follow-ups for symlinks
    // (link -> target, broken -> ENOENT, loop-a -> ELOOP chain).
    const followUps = events.filter(
      (e) => e.type === "query" && !isBatchQuery(e),
    ).length;
    const batchedQueries = events.filter(isBatchQuery).length;
    expect(batchedQueries).toBe(1);
    expect(followUps).toBeGreaterThan(0);
  });

  it("coalesces exists and lstat the same way", async () => {
    const seqExists: Outcome[] = [];
    const seqLstat: Outcome[] = [];
    for (const p of PATHS) {
      seqExists.push(await settle(fs.exists(p)));
      seqLstat.push(shape(await settle(fs.lstat(p))));
    }
    events.length = 0;

    const [exists, lstat] = await Promise.all([
      Promise.all(PATHS.map((p) => settle(fs.exists(p)))),
      Promise.all(PATHS.map((p) => settle(fs.lstat(p)))),
    ]);

    expect(exists).toEqual(seqExists);
    expect(lstat.map(shape)).toEqual(seqLstat);
    expect(sqlCount()).toBe(1);
  });

  it("keeps a lone call on the single-path query", async () => {
    await fs.exists("/"); // resolve and cache the version id first
    events.length = 0;
    await fs.stat("/d/f0.txt");
    await fs.exists("/d/f1.txt");
    const qs = events.filter((e) => e.type === "query");
    expect(qs).toHaveLength(2);
    expect(qs.some(isBatchQuery)).toBe(false);
  });

  it("does not batch inside a transaction and sees its uncommitted writes", async () => {
    await fs.transaction(async (tx) => {
      await tx.writeFile("/d/new.txt", "fresh");
      const [a, b] = await Promise.all([
        tx.exists("/d/new.txt"),
        tx.stat("/d/new.txt"),
      ]);
      expect(a).toBe(true);
      expect(b.size).toBe(5);
    });
    expect(events.filter(isBatchQuery)).toHaveLength(0);
  });

  it("rejects every caller in a batch when the query fails", async () => {
    const failing: SqlClient = {
      query: (text, params) =>
        text.includes("ANY($2::ltree[])")
          ? Promise.reject(new Error("boom"))
          : client.query(text, params),
      transaction: (fn) => client.transaction(fn),
    };
    const broken = new PgFileSystem({ db: failing, workspaceId: WS });
    const results = await Promise.all(
      ["/d/f0.txt", "/d/f1.txt", "/d/f2.txt"].map((p) => settle(broken.stat(p))),
    );
    expect(results).toEqual([
      { err: "Error: boom" },
      { err: "Error: boom" },
      { err: "Error: boom" },
    ]);
    // The next burst starts a fresh batch.
    const ok = new PgFileSystem({ db: client, workspaceId: WS });
    const again = await Promise.all(["/d/f0.txt", "/d/f1.txt"].map((p) => ok.exists(p)));
    expect(again).toEqual([true, true]);
  });
});
