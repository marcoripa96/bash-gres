import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient, TraceEvent } from "../lib/core/types.js";

const WS = "batched-lookups";

/** The multi-path lookups a coalesced batch sends (entries, or entries + blobs). */
const isBatchQuery = (e: TraceEvent) =>
  e.type === "query" && e.sql.includes("ANY($2::ltree[])");
const isReadBatch = (e: TraceEvent) =>
  isBatchQuery(e) && e.type === "query" && e.sql.includes("fs_blobs");

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
    await writer.writeFile("/d/empty.txt", "");
    await writer.writeFile("/d/bin.dat", new TextEncoder().encode("bytes"));
    await writer.writeFile("/d/big.txt", "x".repeat(64));
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

  it("falls back to per-call queries when a batch statement fails", async () => {
    let batchFailures = 0;
    const failing: SqlClient = {
      query: (text, params) => {
        if (text.includes("ANY($2::ltree[])")) {
          batchFailures++;
          return Promise.reject(new Error("statement timeout"));
        }
        return client.query(text, params);
      },
      transaction: (fn) => client.transaction(fn),
    };
    const flaky = new PgFileSystem({ db: failing, workspaceId: WS });
    const results = await Promise.all(
      ["/d/f0.txt", "/d/missing.txt", "/d/sub"].map((p) => settle(flaky.exists(p))),
    );
    expect(batchFailures).toBe(1);
    expect(results).toEqual([{ ok: true }, { ok: false }, { ok: true }]);
  });

  it("fails only the call whose path can't be encoded", async () => {
    const tooLong = "/d/" + "a".repeat(300);
    const alone = await settle(fs.exists(tooLong));
    expect("err" in alone).toBe(true);

    const [bad, good, missing] = await Promise.all([
      settle(fs.exists(tooLong)),
      settle(fs.exists("/d/f0.txt")),
      settle(fs.stat("/d/missing.txt")),
    ]);
    expect(bad).toEqual(alone);
    expect(good).toEqual({ ok: true });
    expect(missing).toEqual({ err: "ENOENT" });
  });

  it("splits bursts larger than one statement carries", async () => {
    await fs.exists("/"); // resolve and cache the version id first
    events.length = 0;
    const paths = Array.from({ length: 300 }, (_, i) => `/d/n${i}.txt`);
    const found = await Promise.all(paths.map((p) => fs.exists(p)));
    expect(found.every((x) => x === false)).toBe(true);
    // 256 + 44: two batch statements, issued together.
    expect(events.filter(isBatchQuery)).toHaveLength(2);
  });

  it("keeps mount-hidden paths hidden inside a batch", async () => {
    const view = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [{ path: "/d/sub" }],
    });
    const results = await Promise.all(
      ["/d/f0.txt", "/d/sub", "/d", "/"].map((p) => settle(view.exists(p))),
    );
    // Outside the mount is invisible; the mount and its ancestors are visible.
    expect(results).toEqual([
      { ok: false },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    const reads = await Promise.all(
      ["/d/f0.txt", "/d/f1.txt"].map((p) => settle(view.readFile(p))),
    );
    expect(reads).toEqual([{ err: "ENOENT" }, { err: "ENOENT" }]);
  });

  describe("readFile", () => {
    const READS = [
      "/d/f0.txt",
      "/d/f1.txt",
      "/d/f1.txt", // duplicate in the same batch
      "/d/empty.txt",
      "/d/bin.dat",
      "/d/big.txt", // over maxReadSize below
      "/d/sub", // directory
      "/d/missing.txt",
      "/d/secret.log", // excluded
      "/d/link",
      "/d/broken",
      "/d/loop-a",
    ];

    let reader: PgFileSystem;
    beforeEach(() => {
      reader = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
        maxReadSize: 32,
        trace: (e) => events.push(e),
      });
    });

    it("answers a burst with one query, same results as one at a time", async () => {
      const sequential: Outcome[] = [];
      for (const p of READS) sequential.push(await settle(reader.readFile(p)));
      events.length = 0;

      const batched = await Promise.all(READS.map((p) => settle(reader.readFile(p))));

      expect(batched).toEqual(sequential);
      expect(sequential).toContainEqual({ err: "EISDIR" });
      expect(sequential).toContainEqual({ err: "E2BIG" });
      expect(sequential).toContainEqual({ err: "ELOOP" });
      expect(sequential).toContainEqual({ ok: "bytes" });
      expect(events.filter(isReadBatch)).toHaveLength(1);
    });

    it("fails only the read whose path can't be encoded", async () => {
      const tooLong = "/d/" + "b".repeat(300);
      const alone = await settle(reader.readFile(tooLong));
      expect("err" in alone).toBe(true);
      const paths = [tooLong, ...Array.from({ length: 20 }, (_, i) => `/d/f${i}.txt`)];
      const results = await Promise.all(paths.map((p) => settle(reader.readFile(p))));
      expect(results[0]).toEqual(alone);
      expect(results.slice(1)).toEqual(
        Array.from({ length: 20 }, (_, i) => ({ ok: `${i}` })),
      );
    });

    it("splits bursts larger than one statement carries", async () => {
      await reader.readFile("/d/f0.txt"); // resolve and cache the version id first
      events.length = 0;
      const paths = [
        ...Array.from({ length: 20 }, (_, i) => `/d/f${i}.txt`),
        ...Array.from({ length: 20 }, (_, i) => `/d/gone${i}.txt`),
      ];
      const results = await Promise.all(paths.map((p) => settle(reader.readFile(p))));
      expect(results.slice(0, 20)).toEqual(
        Array.from({ length: 20 }, (_, i) => ({ ok: `${i}` })),
      );
      expect(results.slice(20).every((r) => "err" in r && r.err === "ENOENT")).toBe(true);
      // 40 distinct paths: 32 + 8, two batch statements issued together.
      expect(events.filter(isReadBatch)).toHaveLength(2);
    });

    it("does not batch inside a transaction and sees its uncommitted writes", async () => {
      await reader.transaction(async (tx) => {
        await tx.writeFile("/d/f0.txt", "changed");
        const [a, b] = await Promise.all([
          tx.readFile("/d/f0.txt"),
          tx.readFile("/d/f1.txt"),
        ]);
        expect([a, b]).toEqual(["changed", "1"]);
      });
      expect(events.filter(isReadBatch)).toHaveLength(0);
    });
  });
});
