import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { InMemoryFsCache } from "../lib/core/cache-memory.js";
import type { FsCache } from "../lib/core/cache.js";
import type { SqlClient } from "./helpers.js";

const WS = "cache-test";

/**
 * Wraps a real cache and counts get/set/clear so tests can prove a read was
 * served from cache (no `set`) or that a mutation triggered invalidation.
 */
class CountingCache implements FsCache {
  gets = 0;
  sets = 0;
  clears = 0;
  hits = 0;
  constructor(private readonly inner: FsCache) {}
  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    const v = await this.inner.get(key);
    if (v !== null) this.hits++;
    return v;
  }
  async set(key: string, value: Uint8Array, ttlMs?: number): Promise<void> {
    this.sets++;
    await this.inner.set(key, value, ttlMs);
  }
  async delete(keys: string[]): Promise<void> {
    await this.inner.delete(keys);
  }
  async clear(prefix: string): Promise<void> {
    this.clears++;
    await this.inner.clear(prefix);
  }
}

describe.each(TEST_ADAPTERS)("PgFileSystem cache [%s]", (_name, factory) => {
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
  });

  describe("hit/miss", () => {
    it("second stat call hits the cache without re-running the SQL", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "alpha");
      const setsAfterWrite = cache.sets;

      const s1 = await fs.stat("/a.txt");
      const setsAfterFirstStat = cache.sets;
      expect(setsAfterFirstStat).toBeGreaterThan(setsAfterWrite);

      const s2 = await fs.stat("/a.txt");
      expect(cache.sets).toBe(setsAfterFirstStat);
      expect(s2.size).toBe(s1.size);
      expect(s2.mtime.getTime()).toBe(s1.mtime.getTime());
    });

    it("readFile populates and serves from cache", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "alpha");

      expect(await fs.readFile("/a.txt")).toBe("alpha");
      const hitsBefore = cache.hits;
      expect(await fs.readFile("/a.txt")).toBe("alpha");
      expect(cache.hits).toBe(hitsBefore + 1);
    });

    it("readFileBuffer shares the same cache entry as readFile", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "hello");

      await fs.readFile("/a.txt");
      const setsAfter = cache.sets;
      const buf = await fs.readFileBuffer("/a.txt");
      expect(new TextDecoder().decode(buf)).toBe("hello");
      expect(cache.sets).toBe(setsAfter); // Hit; no second populate
    });

    it("exists hit returns the cached boolean", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "x");

      expect(await fs.exists("/a.txt")).toBe(true);
      const hitsBefore = cache.hits;
      expect(await fs.exists("/a.txt")).toBe(true);
      expect(cache.hits).toBe(hitsBefore + 1);
    });

    it("readdir hit returns the cached array", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/dir/a.txt", "a");
      await fs.writeFile("/dir/b.txt", "b");

      const first = await fs.readdir("/dir");
      const hitsBefore = cache.hits;
      const second = await fs.readdir("/dir");
      expect(second).toEqual(first);
      expect(cache.hits).toBe(hitsBefore + 1);
    });
  });

  describe("invalidation", () => {
    it("writeFile clears the workspace+version prefix on success", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();

      const clearsBefore = cache.clears;
      await fs.writeFile("/a.txt", "alpha");
      expect(cache.clears).toBeGreaterThan(clearsBefore);
    });

    it("a write makes the next stat read fresh data", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "alpha");

      const s1 = await fs.stat("/a.txt");
      await fs.writeFile("/a.txt", "alpha-but-longer-now");
      const s2 = await fs.stat("/a.txt");
      expect(s2.size).toBeGreaterThan(s1.size);
    });

    it("rm invalidates exists()", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "x");

      expect(await fs.exists("/a.txt")).toBe(true);
      await fs.rm("/a.txt");
      expect(await fs.exists("/a.txt")).toBe(false);
    });
  });

  describe("transaction semantics", () => {
    it("rolled-back writes do not invalidate the cache", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "alpha");

      // Prime the cache.
      await fs.readFile("/a.txt");
      const clearsBefore = cache.clears;

      await expect(
        fs.transaction(async (tx) => {
          await tx.writeFile("/a.txt", "should-not-stick");
          throw new Error("rollback");
        }),
      ).rejects.toThrow(/rollback/);

      // No commit -> no invalidation.
      expect(cache.clears).toBe(clearsBefore);
      // And the cached entry should still serve the original value.
      expect(await fs.readFile("/a.txt")).toBe("alpha");
    });

    it("committed writes inside transaction(fn) do invalidate", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "alpha");
      await fs.readFile("/a.txt");

      await fs.transaction(async (tx) => {
        await tx.writeFile("/a.txt", "beta");
      });

      expect(await fs.readFile("/a.txt")).toBe("beta");
    });

    it("reads inside transaction(fn) bypass the cache to see uncommitted writes", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "alpha");
      // Prime: cached value is "alpha".
      await fs.readFile("/a.txt");

      await fs.transaction(async (tx) => {
        await tx.writeFile("/a.txt", "beta");
        // Must see its own write, not the cached "alpha".
        expect(await tx.readFile("/a.txt")).toBe("beta");
      });
    });
  });

  describe("isolation", () => {
    it("two workspaces sharing a cache cannot read each other's entries", async () => {
      const sharedCache = new InMemoryFsCache();
      const fsA = new PgFileSystem({
        db: client,
        workspaceId: `${WS}-a`,
        cache: sharedCache,
      });
      const fsB = new PgFileSystem({
        db: client,
        workspaceId: `${WS}-b`,
        cache: sharedCache,
      });
      await fsA.init();
      await fsB.init();
      await fsA.writeFile("/x.txt", "from-a");
      await fsB.writeFile("/x.txt", "from-b");

      expect(await fsA.readFile("/x.txt")).toBe("from-a");
      expect(await fsB.readFile("/x.txt")).toBe("from-b");
      // Re-read to exercise the cache path; values must remain isolated.
      expect(await fsA.readFile("/x.txt")).toBe("from-a");
      expect(await fsB.readFile("/x.txt")).toBe("from-b");

      await resetWorkspace(client, `${WS}-a`);
      await resetWorkspace(client, `${WS}-b`);
    });

    it("two versions sharing a cache cannot read each other's entries", async () => {
      const sharedCache = new InMemoryFsCache();
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        cache: sharedCache,
      });
      await main.init();
      await main.writeFile("/x.txt", "main-v1");
      const branch = await main.fork("branch");
      await branch.writeFile("/x.txt", "branch-v1");

      expect(await main.readFile("/x.txt")).toBe("main-v1");
      expect(await branch.readFile("/x.txt")).toBe("branch-v1");
      expect(await main.readFile("/x.txt")).toBe("main-v1");
      expect(await branch.readFile("/x.txt")).toBe("branch-v1");
    });
  });

  describe("readFileLines piggyback", () => {
    it("serves line slices from a populated readFile cache without DB", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      const text = "one\ntwo\nthree\nfour\nfive\n";
      await fs.writeFile("/a.txt", text);
      // Populate readFile cache.
      await fs.readFile("/a.txt");

      const setsBefore = cache.sets;
      const r = await fs.readFileLines("/a.txt", { offset: 2, limit: 2 });
      expect(r.content).toBe("two\nthree");
      expect(r.total).toBe(5);
      // Piggyback rule: no per-range cache entry written.
      expect(cache.sets).toBe(setsBefore);
    });

    it("does not backfill the readFile cache from a readFileLines call", async () => {
      const cache = new CountingCache(new InMemoryFsCache());
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "one\ntwo\nthree\n");

      // First op is readFileLines on a cold cache.
      const setsBeforeLines = cache.sets;
      const r = await fs.readFileLines("/a.txt", { offset: 1, limit: 2 });
      expect(r.content).toBe("one\ntwo");
      // No backfill rule: a line read does not populate the full-file cache.
      expect(cache.sets).toBe(setsBeforeLines);

      // A subsequent readFile should therefore still miss.
      const setsBeforeFile = cache.sets;
      await fs.readFile("/a.txt");
      expect(cache.sets).toBeGreaterThan(setsBeforeFile);
    });

    it("respects the SQL semantics of trailing newline (no phantom empty line)", async () => {
      const cache = new InMemoryFsCache();
      const fs = new PgFileSystem({ db: client, workspaceId: WS, cache });
      await fs.init();
      await fs.writeFile("/a.txt", "one\ntwo\n");
      await fs.readFile("/a.txt"); // populate

      const r = await fs.readFileLines("/a.txt");
      expect(r.total).toBe(2);
      expect(r.content).toBe("one\ntwo");
    });
  });
});
