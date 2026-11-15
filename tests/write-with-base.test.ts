import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TEST_ADAPTERS, createTestSql, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { createDrizzleClient } from "../lib/adapters/drizzle/adapter.js";
import {
  FsBaseUnavailableError,
  FsWriteConflictError,
  contentHash,
  textMergeResolver,
  type MergeConflictInput,
  type SqlClient,
  type SqlParam,
} from "../lib/core/index.js";

const WS = "write-with-base-test";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise and its resolver, to hold a transaction open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** Counts statements; a transaction counts as BEGIN + COMMIT. */
function counting(inner: SqlClient, counter: { n: number }): SqlClient {
  return {
    query: (text: string, params?: SqlParam[]) => {
      counter.n++;
      return inner.query(text, params);
    },
    transaction: (fn) => {
      counter.n += 2;
      return inner.transaction((tx) => fn(counting(tx, counter)));
    },
  };
}

const DOC = "# Report\n\nintro\n\nbody\n\nend\n";

describe("contentHash", () => {
  it("is the hex sha256 of the UTF-8 bytes", () => {
    expect(contentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(contentHash("abc")).toBe(contentHash(new TextEncoder().encode("abc")));
  });
});

describe.each(TEST_ADAPTERS)("writeFileWithBase [%s]", (_name, factory) => {
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

  async function open(version = "main", db: SqlClient = client) {
    const fs = new PgFileSystem({ db, workspaceId: WS, version });
    await fs.init();
    return fs;
  }

  async function storedHashOf(path: string, fs: PgFileSystem): Promise<string> {
    return contentHash(await fs.readFile(path));
  }

  describe("base matches", () => {
    it("writes the content, by content or by hash, and reports its hash", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", DOC);

      const r1 = await fs.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
      expect(r1).toEqual({ outcome: "written", hash: contentHash("v1") });
      expect(await fs.readFile("/doc.md")).toBe("v1");

      const r2 = await fs.writeFileWithBase("/doc.md", "v2", {
        base: { hash: contentHash("v1") },
      });
      expect(r2).toEqual({ outcome: "written", hash: contentHash("v2") });
      expect(await fs.readFile("/doc.md")).toBe("v2");
    });

    it("takes one statement on the fast path", async () => {
      const counter = { n: 0 };
      const fs = await open("main", counting(client, counter));
      await fs.writeFile("/doc.md", DOC);
      counter.n = 0;
      await fs.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
      expect(counter.n).toBe(1);
      expect(await fs.readFile("/doc.md")).toBe("v1");
    });

    it("reports unchanged when the file already holds the content", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "same");
      const r = await fs.writeFileWithBase("/doc.md", "same", { base: { content: "old" } });
      expect(r).toEqual({ outcome: "unchanged", hash: contentHash("same") });
    });

    it("leaves last_write_at alone when unchanged, on both paths", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "same");
      const before = await fs.getLastModified();
      await sleep(20);
      // Fast path (the handle knows its version id).
      await fs.writeFileWithBase("/doc.md", "same", { base: { content: "old" } });
      // Transactional path.
      await fs.transaction((tx) =>
        tx.writeFileWithBase("/doc.md", "same", { base: null, resolve: () => undefined }),
      );
      expect(await fs.getLastModified()).toEqual(before);
      await fs.writeFileWithBase("/doc.md", "next", { base: { content: "same" } });
      expect((await fs.getLastModified())!.getTime()).toBeGreaterThan(before!.getTime());
    });

    it("keeps the file's mode", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", DOC);
      await fs.chmod("/doc.md", 0o600);
      await fs.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
      expect((await fs.stat("/doc.md")).mode & 0o777).toBe(0o600);
      await fs.writeFileWithBase("/doc.md", "v2", {
        base: { content: "stale" },
        resolve: () => ({ content: "v2" }),
      });
      expect((await fs.stat("/doc.md")).mode & 0o777).toBe(0o600);
    });

    it("creates a file and its parents from a null base", async () => {
      const fs = await open();
      const r = await fs.writeFileWithBase("/a/b/new.md", "hello", { base: null });
      expect(r).toEqual({ outcome: "written", hash: contentHash("hello") });
      expect(await fs.readFile("/a/b/new.md")).toBe("hello");
    });

    it("matches an empty file", async () => {
      const fs = await open();
      await fs.writeFile("/empty.md", "");
      const r = await fs.writeFileWithBase("/empty.md", "x", { base: { hash: contentHash("") } });
      expect(r.outcome).toBe("written");
    });

    it("applies writeFile's size limit", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS, maxFileSize: 4 });
      await fs.init();
      await fs.writeFile("/doc.md", "ab");
      await expect(
        fs.writeFileWithBase("/doc.md", "too long", { base: { content: "ab" } }),
      ).rejects.toThrow(/File too large/);
      await expect(
        fs.writeFileWithBase("/doc.md", "x", {
          base: { content: "zz" },
          resolve: () => ({ content: "too long" }),
        }),
      ).rejects.toThrow(/File too large/);
      expect(await fs.readFile("/doc.md")).toBe("ab");
    });
  });

  describe("base differs", () => {
    it("fails without a resolver, carrying the stored hash, and writes nothing", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "theirs-first");
      const err = await fs
        .writeFileWithBase("/doc.md", "mine", { base: { content: DOC } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FsWriteConflictError);
      expect(err).toMatchObject({
        code: "ECONFLICT",
        reason: "no-resolver",
        currentHash: contentHash("theirs-first"),
        currentType: "file",
      });
      expect(await fs.readFile("/doc.md")).toBe("theirs-first");
    });

    it("merges with textMergeResolver and returns the merged content", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", DOC);
      const editor = DOC.replace("intro", "intro (editor)");
      const agent = DOC.replace("end", "end (agent)");
      await fs.writeFileWithBase("/doc.md", editor, { base: { content: DOC } });
      const r = await fs.writeFileWithBase("/doc.md", agent, {
        base: { hash: contentHash(DOC) },
        resolve: textMergeResolver,
      });
      const merged = DOC.replace("intro", "intro (editor)").replace("end", "end (agent)");
      expect(r).toEqual({ outcome: "merged", hash: contentHash(merged), content: merged });
      expect(await fs.readFile("/doc.md")).toBe(merged);
    });

    it("hands base, ours and theirs to the resolver", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "ours");
      let seen: MergeConflictInput | null = null;
      await fs.writeFileWithBase("/doc.md", "theirs", {
        base: { content: "base" },
        resolve: (c) => {
          seen = c;
          return { content: "settled" };
        },
      });
      expect(seen).toMatchObject({
        path: "/doc.md",
        base: { type: "file", content: "base", blobHash: contentHash("base") },
        ours: { type: "file", content: "ours", blobHash: contentHash("ours") },
        theirs: { type: "file", content: "theirs", blobHash: contentHash("theirs") },
      });
      expect(await fs.readFile("/doc.md")).toBe("settled");
    });

    it("fails when the resolver declines", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "ours");
      for (const declined of [null, undefined]) {
        await expect(
          fs.writeFileWithBase("/doc.md", "theirs", {
            base: { content: "base" },
            resolve: () => declined,
          }),
        ).rejects.toMatchObject({ code: "ECONFLICT", reason: "declined" });
      }
      expect(await fs.readFile("/doc.md")).toBe("ours");
    });

    it("refuses a resolution that is not one, as merge() does", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "ours");
      await expect(
        fs.writeFileWithBase("/doc.md", "theirs", {
          base: { content: "base" },
          // @ts-expect-error: not a MergeResolution
          resolve: () => ({ text: "x" }),
        }),
      ).rejects.toThrow(/writeFileWithBase: resolver for '\/doc.md' must return/);
      expect(await fs.readFile("/doc.md")).toBe("ours");
    });

    it("removes the file on { remove: true }", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "ours");
      const r = await fs.writeFileWithBase("/doc.md", "theirs", {
        base: { content: "base" },
        resolve: () => ({ remove: true }),
      });
      expect(r).toEqual({ outcome: "removed", hash: null });
      expect(await fs.exists("/doc.md")).toBe(false);
    });

    it("reports merged without writing when the resolver keeps what is stored", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "ours");
      const r = await fs.writeFileWithBase("/doc.md", "theirs", {
        base: { content: "base" },
        resolve: (c) => ({ content: c.ours!.content! }),
      });
      expect(r).toEqual({ outcome: "merged", hash: contentHash("ours"), content: "ours" });
    });

    it("passes ours as null when the file was deleted since the base", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "base");
      await fs.rm("/doc.md");
      const err = await fs
        .writeFileWithBase("/doc.md", "mine", { base: { content: "base" } })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: "no-resolver", currentHash: null, currentType: null });
      let ours: unknown = "unset";
      await fs.writeFileWithBase("/doc.md", "mine", {
        base: { content: "base" },
        resolve: (c) => {
          ours = c.ours;
          return { content: "mine" };
        },
      });
      expect(ours).toBeNull();
      expect(await fs.readFile("/doc.md")).toBe("mine");
    });

    it("is a conflict on a directory or a symlink, without calling the resolver", async () => {
      const fs = await open();
      await fs.mkdir("/dir");
      await fs.writeFile("/target.md", "t");
      await fs.symlink("/target.md", "/link.md");
      let called = false;
      const resolve = () => {
        called = true;
        return { content: "x" };
      };
      await expect(
        fs.writeFileWithBase("/dir", "x", { base: null, resolve }),
      ).rejects.toMatchObject({ reason: "not-a-file", currentType: "directory" });
      await expect(
        fs.writeFileWithBase("/link.md", "x", { base: { content: "t" }, resolve }),
      ).rejects.toMatchObject({ reason: "not-a-file", currentType: "symlink" });
      expect(called).toBe(false);
      expect(await fs.readFile("/target.md")).toBe("t");
    });
  });

  describe("base by hash whose blob is gone", () => {
    it("fails with FsBaseUnavailableError when the resolver needs it; text works", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", "v1");
      await fs.writeFile("/doc.md", "v2");
      await client.query(
        `DELETE FROM fs_blobs WHERE workspace_id = $1 AND hash = decode($2, 'hex')`,
        [WS, contentHash("v1")],
      );
      const err = await fs
        .writeFileWithBase("/doc.md", "v3", {
          base: { hash: contentHash("v1") },
          resolve: textMergeResolver,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FsBaseUnavailableError);
      expect(err).toMatchObject({ code: "ENOBASE", baseHash: contentHash("v1") });

      // Without a resolver the base text is not needed: a plain conflict.
      await expect(
        fs.writeFileWithBase("/doc.md", "v3", { base: { hash: contentHash("v1") } }),
      ).rejects.toMatchObject({ reason: "no-resolver", currentHash: contentHash("v2") });

      const r = await fs.writeFileWithBase("/doc.md", "v3", {
        base: { content: "v1" },
        resolve: (c) => ({ content: `${c.base!.content}+${c.ours!.content}+${c.theirs!.content}` }),
      });
      expect(r.content).toBe("v1+v2+v3");
      expect(await fs.readFile("/doc.md")).toBe("v1+v2+v3");
    });
  });

  describe("concurrent writers", () => {
    it("two writes from the same base: the second merges, neither is lost", async () => {
      for (let round = 0; round < 5; round++) {
        await resetWorkspace(client, WS);
        const seed = await open();
        await seed.writeFile("/doc.md", DOC);
        const a = await open();
        const b = await open();
        const editor = DOC.replace("intro", `intro (editor ${round})`);
        const agent = DOC.replace("end", `end (agent ${round})`);
        const [ra, rb] = await Promise.all([
          a.writeFileWithBase("/doc.md", editor, { base: { content: DOC }, resolve: textMergeResolver }),
          b.writeFileWithBase("/doc.md", agent, { base: { content: DOC }, resolve: textMergeResolver }),
        ]);
        expect([ra.outcome, rb.outcome].sort()).toEqual(["merged", "written"]);
        const final = await seed.readFile("/doc.md");
        expect(final).toContain(`intro (editor ${round})`);
        expect(final).toContain(`end (agent ${round})`);
      }
    });

    it("two writes from the same base without a resolver: the second fails, nothing of it lands", async () => {
      for (let round = 0; round < 5; round++) {
        await resetWorkspace(client, WS);
        const seed = await open();
        await seed.writeFile("/doc.md", DOC);
        const a = await open();
        const b = await open();
        const results = await Promise.allSettled([
          a.writeFileWithBase("/doc.md", "from a", { base: { content: DOC } }),
          b.writeFileWithBase("/doc.md", "from b", { base: { content: DOC } }),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const failed = results.filter((r) => r.status === "rejected");
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        const reason = (failed[0] as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(FsWriteConflictError);
        const final = await seed.readFile("/doc.md");
        expect(["from a", "from b"]).toContain(final);
        expect(reason.currentHash).toBe(contentHash(final));
      }
    });

    it("a write that commits while the fast path waits is seen, not overwritten", async () => {
      const a = await open();
      const b = await open();
      await b.writeFile("/doc.md", DOC); // b's version id is now cached
      const g = gate();
      const written = gate();
      const holder = a.transaction(async (tx) => {
        await tx.writeFile("/doc.md", "committed meanwhile");
        written.open();
        await g.wait;
      });
      await written.wait;
      let settled = false;
      const pending = b
        .writeFileWithBase("/doc.md", "stale write", { base: { content: DOC } })
        .finally(() => (settled = true));
      await sleep(300);
      expect(settled).toBe(false); // waiting on the version row
      g.open();
      await holder;
      await expect(pending).rejects.toMatchObject({
        reason: "no-resolver",
        currentHash: contentHash("committed meanwhile"),
      });
      expect(await a.readFile("/doc.md")).toBe("committed meanwhile");
    });

    it("a file created by another writer meanwhile is a conflict for a null base", async () => {
      const a = await open();
      const b = await open();
      const g = gate();
      const written = gate();
      const holder = a.transaction(async (tx) => {
        await tx.writeFileWithBase("/new.md", "from a", { base: null });
        written.open();
        await g.wait;
      });
      await written.wait;
      let seen: MergeConflictInput | null = null;
      const pending = b.writeFileWithBase("/new.md", "from b", {
        base: null,
        resolve: (c) => {
          seen = c;
          return { content: `${c.ours!.content}|${c.theirs!.content}` };
        },
      });
      await sleep(200);
      g.open();
      await holder;
      const r = await pending;
      expect(r.outcome).toBe("merged");
      expect(seen).toMatchObject({ base: null, ours: { content: "from a" }, theirs: { content: "from b" } });
      expect(await a.readFile("/new.md")).toBe("from a|from b");

      await resetWorkspace(client, WS);
      const c1 = await open();
      const c2 = await open();
      const res = await Promise.allSettled([
        c1.writeFileWithBase("/new.md", "one", { base: null }),
        c2.writeFileWithBase("/new.md", "two", { base: null }),
      ]);
      expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const rejected = res.find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(FsWriteConflictError);
    });

    it("a write to a fork's unfrozen parent is seen through the inherited view", async () => {
      const main = await open();
      await main.writeFile("/doc.md", "P1");
      const child = await main.fork("child");
      const g = gate();
      const written = gate();
      const holder = main.transaction(async (tx) => {
        await tx.writeFile("/doc.md", "P2");
        written.open();
        await g.wait;
      });
      await written.wait;
      const pending = child.writeFileWithBase("/doc.md", "C", { base: { content: "P1" } });
      await sleep(200);
      g.open();
      await holder;
      await expect(pending).rejects.toMatchObject({
        reason: "no-resolver",
        currentHash: contentHash("P2"),
      });
      expect(await child.readFile("/doc.md")).toBe("P2");

      // From the inherited content it writes into the fork.
      const r = await child.writeFileWithBase("/doc.md", "C", { base: { content: "P2" } });
      expect(r.outcome).toBe("written");
      expect(await child.readFile("/doc.md")).toBe("C");
      expect(await main.readFile("/doc.md")).toBe("P2");
    });
  });

  describe("versions and transactions", () => {
    it("is EPERM on a frozen version, before any comparison", async () => {
      const root = await open();
      await root.mkdir("/artifacts/a1", { recursive: true, versioned: true });
      const main = await root.versioned("/artifacts/a1");
      await main.writeFile("/doc.md", "v1");
      await main.freeze();
      for (const call of [
        () => main.writeFileWithBase("/doc.md", "v2", { base: { content: "v1" } }),
        () => main.writeFileWithBase("/doc.md", "v1", { base: { content: "zz" } }),
        () => main.writeFileWithBase("/doc.md", "v2", { base: { content: "zz" } }),
        () => main.transaction((tx) => tx.writeFileWithBase("/doc.md", "v2", { base: { content: "v1" } })),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "EPERM", message: expect.stringMatching(/version is frozen/) });
      }
      expect(await main.readFile("/doc.md")).toBe("v1");
    });

    it("works on a versioned(path) handle", async () => {
      const root = await open();
      await root.mkdir("/artifacts/a1", { recursive: true, versioned: true });
      const main = await root.versioned("/artifacts/a1");
      await main.writeFile("/doc.md", DOC);
      await main.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
      const r = await main.writeFileWithBase("/doc.md", "v2", {
        base: { content: DOC },
        resolve: (c) => ({ content: `${c.ours!.content}+${c.theirs!.content}` }),
      });
      expect(r.content).toBe("v1+v2");
      expect(await main.readFile("/doc.md")).toBe("v1+v2");
      const reopened = await root.versioned("/artifacts/a1");
      expect(await reopened.readFile("/doc.md")).toBe("v1+v2");
    });

    it("works inside fs.transaction() and rolls back with it", async () => {
      const fs = await open();
      await fs.writeFile("/doc.md", DOC);
      await fs.transaction(async (tx) => {
        await tx.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
        await tx.writeFileWithBase("/doc.md", "v2", { base: { content: "v1" } });
      });
      expect(await fs.readFile("/doc.md")).toBe("v2");
      await expect(
        fs.transaction(async (tx) => {
          await tx.writeFileWithBase("/doc.md", "v3", { base: { content: "v2" } });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await fs.readFile("/doc.md")).toBe("v2");
    });

    it("runs the transactional path under chunking and a byte quota", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        maxWorkspaceBytes: 1_000_000,
        chunking: {},
      });
      await fs.init();
      await fs.writeFile("/doc.md", DOC);
      const r = await fs.writeFileWithBase("/doc.md", "# v1\n\ntext\n", { base: { content: DOC } });
      expect(r.outcome).toBe("written");
      expect((await fs.readFileChunks("/doc.md")).length).toBeGreaterThan(0);
    });
  });
});

describe("writeFileWithBase in a Drizzle transaction", () => {
  const sql = createTestSql();
  const db = drizzle(sql);
  const plain = createDrizzleClient(db);

  beforeAll(async () => {
    await ensureSetup();
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await resetWorkspace(plain, WS);
  });

  it("commits with the Drizzle transaction", async () => {
    const seed = new PgFileSystem({ db: plain, workspaceId: WS });
    await seed.init();
    await seed.writeFile("/doc.md", DOC);
    await db.transaction(async (tx) => {
      const fs = new PgFileSystem({ db: createDrizzleClient(tx), workspaceId: WS });
      const r1 = await fs.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
      // The handle now knows its version id: this one takes the fast path.
      const r2 = await fs.writeFileWithBase("/doc.md", "v2", { base: { content: "v1" } });
      const r3 = await fs.writeFileWithBase("/doc.md", "v3", {
        base: { content: "v1" },
        resolve: (c) => ({ content: `${c.ours!.content}+${c.theirs!.content}` }),
      });
      expect([r1.outcome, r2.outcome, r3.outcome]).toEqual(["written", "written", "merged"]);
    });
    expect(await seed.readFile("/doc.md")).toBe("v2+v3");
  });

  it("rolls back with the Drizzle transaction", async () => {
    const seed = new PgFileSystem({ db: plain, workspaceId: WS });
    await seed.init();
    await seed.writeFile("/doc.md", DOC);
    await expect(
      db.transaction(async (tx) => {
        const fs = new PgFileSystem({ db: createDrizzleClient(tx), workspaceId: WS });
        await fs.writeFileWithBase("/doc.md", "v1", { base: { content: DOC } });
        await fs.writeFileWithBase("/doc.md", "v2", { base: { content: "v1" } });
        await fs.writeFileWithBase("/new.md", "n", { base: null });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await seed.readFile("/doc.md")).toBe(DOC);
    expect(await seed.exists("/new.md")).toBe(false);
  });
});
