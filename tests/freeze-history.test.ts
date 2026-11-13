import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TEST_ADAPTERS, createTestSql, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { createDrizzleClient } from "../lib/adapters/drizzle/adapter.js";
import { textMergeResolver } from "../lib/core/index.js";
import type { SqlClient } from "./helpers.js";

const WS = "freeze-history-test";

describe.each(TEST_ADAPTERS)("freeze, materialize, history [%s]", (_name, factory) => {
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

  const open = (version = "main", historyRetention: "retain" | "discard" = "retain") =>
    new PgFileSystem({ db: client, workspaceId: WS, version, historyRetention });

  async function closureRows(): Promise<number> {
    const r = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM version_ancestors WHERE workspace_id = $1`,
      [WS],
    );
    return Number(r.rows[0]!.n);
  }

  async function artifactRoot() {
    const root = new PgFileSystem({ db: client, workspaceId: WS, historyRetention: "retain" });
    await root.init();
    await root.mkdir("/artifacts/a1", { recursive: true, versioned: true });
    return { root, main: await root.versioned("/artifacts/a1") };
  }

  describe("freeze", () => {
    it("refuses every content write, from any handle", async () => {
      const main = open();
      await main.init();
      await main.writeFile("/f.txt", "v1");
      await main.mkdir("/d");
      await main.writeFile("/d/x", "x");
      const stale = open();
      await stale.readFile("/f.txt");
      const other = await main.fork("other");
      await other.writeFile("/f.txt", "other");
      await main.freeze();
      await main.freeze(); // idempotent

      const refused: Array<[string, () => Promise<unknown>]> = [
        ["writeFile", () => stale.writeFile("/f.txt", "v2")],
        ["appendFile", () => stale.appendFile("/f.txt", "+")],
        ["mkdir", () => stale.mkdir("/new")],
        ["rm", () => stale.rm("/f.txt")],
        ["rm -r", () => stale.rm("/d", { recursive: true })],
        ["cp", () => stale.cp("/f.txt", "/g.txt")],
        ["mv", () => stale.mv("/f.txt", "/g.txt")],
        ["chmod", () => stale.chmod("/f.txt", 0o600)],
        ["utimes", () => stale.utimes("/f.txt", new Date(), new Date())],
        ["symlink", () => stale.symlink("/f.txt", "/l")],
        ["link", () => stale.link("/f.txt", "/h")],
        ["transaction", () => stale.transaction((tx) => tx.writeFile("/t", "t"))],
        ["cherryPick", () => stale.cherryPick("other", ["/f.txt"])],
        ["revert", () => stale.revert("other", { paths: ["/f.txt"] })],
        ["merge", () => stale.merge("other")],
      ];
      for (const [name, write] of refused) {
        await expect(write(), name).rejects.toMatchObject({
          code: "EPERM",
          message: expect.stringContaining("version is frozen"),
        });
      }
      expect(await main.readFile("/f.txt")).toBe("v1");
      expect((await main.walk("/")).map((e) => e.path).sort()).toEqual([
        "/d",
        "/d/x",
        "/f.txt",
      ]);
    });

    it("leaves forks, label moves, detach and root removal working", async () => {
      const { root, main } = await artifactRoot();
      await main.writeFile("/app.jsx", "v1");
      await main.freeze();
      const chat = await main.fork("chat");
      await chat.writeFile("/app.jsx", "v2");
      expect(await chat.readFile("/app.jsx")).toBe("v2");
      await main.renameVersion("published");
      await main.detach();
      expect(await main.readFile("/app.jsx")).toBe("v1");
      await root.rm("/artifacts/a1", { recursive: true, deleteVersionRoot: true });
      await expect(root.versioned("/artifacts/a1")).rejects.toMatchObject({
        code: "ENOTVERSIONED",
      });
    });

    it("reports frozenAt in listHistory", async () => {
      const main = open();
      await main.init();
      const before = (await main.listHistory()).entries[0]!;
      expect(before.frozenAt).toBeNull();
      expect(before.mergedFrom).toEqual([]);
      await main.freeze();
      expect((await main.listHistory()).entries[0]!.frozenAt).toBeInstanceOf(Date);
    });
  });

  describe("materialize", () => {
    it("cuts the closure, keeps history, content and removals", async () => {
      const main = open();
      await main.init();
      await main.writeFile("/a", "a");
      await main.writeFile("/b", "b");
      const v1 = await main.fork("v1");
      await v1.writeFile("/a", "a1");
      await v1.rm("/b");
      const v2 = await v1.fork("v2");
      await v2.writeFile("/c", "c");
      const v1Id = (await v1.listHistory({ limit: 1 })).entries[0]!.versionId;

      await v2.materialize();
      expect((await v2.walk("/")).map((e) => e.path).sort()).toEqual(["/a", "/c"]);
      expect(await v2.readFile("/a")).toBe("a1");
      const r = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM version_ancestors
         WHERE workspace_id = $1 AND descendant_id = (
           SELECT id FROM fs_versions WHERE workspace_id = $1 AND label = 'v2')`,
        [WS],
      );
      expect(Number(r.rows[0]!.n)).toBe(1);

      const history = await v2.listHistory({ includeChanges: "paths" });
      expect(history.entries.map((e) => e.version)).toEqual(["v2", "v1", "main"]);
      expect(history.entries[0]!.changes.map((c) => [c.path, c.change])).toEqual([
        ["/c", "added"],
      ]);

      // A fork of the materialized version costs two closure rows.
      const v3 = await v2.fork("v3");
      expect(await v3.readFile("/a")).toBe("a1");
      const r3 = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM version_ancestors
         WHERE workspace_id = $1 AND descendant_id = (
           SELECT id FROM fs_versions WHERE workspace_id = $1 AND label = 'v3')`,
        [WS],
      );
      expect(Number(r3.rows[0]!.n)).toBe(2);

      // versionDiff of v1 (not materialized) is unchanged by v2's materialize.
      const d1 = await v2.versionDiff(v1Id);
      expect(d1.map((c) => [c.path, c.change]).sort()).toEqual([
        ["/a", "modified"],
        ["/b", "removed"],
      ]);
      await v1.materialize();
      const d1m = await v2.versionDiff(v1Id);
      expect(d1m.map((c) => [c.path, c.change]).sort()).toEqual([
        ["/a", "modified"],
        ["/b", "removed"],
      ]);
    });
  });

  describe("publishing chain", () => {
    it("stays linear and keeps every version readable and diffable", async () => {
      const { root, main } = await artifactRoot();
      await main.writeFile("/app.jsx", "v0\n");
      await main.writeFile("/queries/q.sql", "select 1\n");
      await main.freeze();
      const N = 30;
      for (let i = 1; i <= N; i++) {
        const head = await root.versioned("/artifacts/a1");
        const chat = await head.fork(`chat-${i}`);
        await chat.writeFile("/app.jsx", `v${i}\n`);
        await chat.promoteTo("main", { dropPrevious: true, freeze: true, materialize: true });
      }
      // One self row per published version, plus the initial version.
      expect(await closureRows()).toBe(1 + N + 1);

      const head = await root.versioned("/artifacts/a1");
      const pages: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await head.listHistory({ limit: 7, cursor });
        pages.push(...page.entries.map((e) => e.versionId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages).toHaveLength(N + 1);
      const all = await head.listHistory({ limit: 1000, includeChanges: "paths" });
      expect(all.entries.map((e) => e.versionId)).toEqual(pages);
      expect(all.entries.every((e) => e.frozenAt !== null)).toBe(true);
      expect(all.entries[0]!.changes.map((c) => c.path)).toEqual(["/app.jsx"]);

      const oldest = pages[pages.length - 1]!;
      const pinned = await root.versioned("/artifacts/a1", { versionId: oldest });
      expect(await pinned.readFile("/app.jsx")).toBe("v0\n");
      expect(await pinned.readFile("/queries/q.sql")).toBe("select 1\n");
      const d = await head.diffVersions(oldest, pages[0]!, { unifiedDiff: true });
      expect(d.map((e) => e.unifiedDiff)).toEqual([
        `--- a/app.jsx\n+++ b/app.jsx\n@@ -1 +1 @@\n-v0\n+v${N}\n`,
      ]);
    });

    it("refuses materialize under discard retention", async () => {
      const main = open("main", "discard");
      await main.init();
      const chat = await main.fork("chat");
      await expect(chat.promoteTo("main", { materialize: true })).rejects.toThrow(/retain/);
    });

    it("freezes on promote under discard retention too", async () => {
      const main = open("main", "discard");
      await main.init();
      const chat = await main.fork("chat");
      await chat.promoteTo("main", { dropPrevious: true, freeze: true });
      await expect(chat.writeFile("/x", "x")).rejects.toMatchObject({ code: "EPERM" });
    });

    it("works on a handle built from a Drizzle transaction", async () => {
      const sql = createTestSql();
      try {
        const db = drizzle(sql);
        const { main } = await artifactRoot();
        await main.writeFile("/app.jsx", "v0");
        await main.freeze();
        await main.fork("chat");
        await db.transaction(async (tx) => {
          const root = new PgFileSystem({
            db: createDrizzleClient(tx),
            workspaceId: WS,
            historyRetention: "retain",
          });
          const chat = await root.versioned("/artifacts/a1", { version: "chat" });
          await chat.writeFile("/app.jsx", "v1");
          await chat.promoteTo("main", { dropPrevious: true, freeze: true, materialize: true });
        });
        const head = await (
          new PgFileSystem({ db: client, workspaceId: WS })
        ).versioned("/artifacts/a1");
        expect(await head.readFile("/app.jsx")).toBe("v1");
        await expect(head.writeFile("/app.jsx", "x")).rejects.toMatchObject({ code: "EPERM" });
      } finally {
        await sql.end();
      }
    });
  });

  describe("merge parents", () => {
    it("bases a later merge on the version a fork already merged", async () => {
      const { root, main } = await artifactRoot();
      await main.writeFile("/q.sql", "a\nb\nc\nd\ne\n");
      await main.freeze();
      const publish = async (label: string, edit: (fs: PgFileSystem) => Promise<void>) => {
        const chat = await root.versioned("/artifacts/a1", { version: label });
        await edit(chat);
        const r = await chat.merge("main", { resolve: textMergeResolver });
        expect(r.conflicts).toEqual([]);
        await chat.promoteTo("main", { dropPrevious: true, freeze: true, materialize: true });
      };
      // G and F fork the first main; H forks F after F is published.
      await main.fork("F");
      await main.fork("G");
      await publish("F", (f) => f.writeFile("/q.sql", "A\nb\nc\nd\ne\n"));
      const h = await (await root.versioned("/artifacts/a1")).fork("H");
      // G merges F (main), recording F as a merge parent, then publishes.
      await publish("G", (g) => g.writeFile("/q.sql", "a\nb\nc\nd\nE\n"));
      // H rewrites F's line. Against the first main this would conflict
      // with G (which carries F's line); against F it is H's change alone.
      await h.writeFile("/q.sql", "A2\nb\nc\nd\ne\n");
      const r = await h.merge("main", { resolve: textMergeResolver });
      expect(r.conflicts).toEqual([]);
      expect(r.resolved).toEqual(["/q.sql"]);
      expect(await h.readFile("/q.sql")).toBe("A2\nb\nc\nd\nE\n");

      const g = (await (await root.versioned("/artifacts/a1")).listHistory({ limit: 1 }))
        .entries[0]!;
      expect(g.mergedFrom).toHaveLength(1);
    });

    it("answers a dry run into a frozen version, refuses the real merge", async () => {
      const main = open();
      await main.init();
      const y = await main.fork("y");
      await y.writeFile("/b", "b");
      const x = await main.fork("x");
      await x.freeze();
      const dry = await x.merge("y", { dryRun: true });
      expect(dry.applied).toEqual(["/b"]);
      await expect(x.merge("y")).rejects.toMatchObject({ code: "EPERM" });
    });

    it("records a merge settled by strategy, as git records a merge commit", async () => {
      const main = open();
      await main.init();
      await main.writeFile("/f", "base");
      const x = await main.fork("x");
      const y = await main.fork("y");
      await x.writeFile("/f", "x");
      await y.writeFile("/f", "y");
      await y.freeze();
      const r = await x.merge("y", { strategy: "ours" });
      expect(r.conflicts.map((c) => c.path)).toEqual(["/f"]);
      expect((await x.listHistory({ limit: 1 })).entries[0]!.mergedFrom).toHaveLength(1);
    });

    it("does not record unfrozen sources, partial merges or dry runs", async () => {
      const main = open();
      await main.init();
      await main.writeFile("/a", "a");
      const x = await main.fork("x");
      const y = await main.fork("y");
      await y.writeFile("/b", "b");
      await x.merge("y", { dryRun: true });
      await x.merge("y");
      await y.freeze();
      await x.merge("y", { paths: ["/b"] });
      await x.merge("y", { dryRun: true });
      expect((await x.listHistory({ limit: 1 })).entries[0]!.mergedFrom).toEqual([]);
      await x.merge("y");
      expect((await x.listHistory({ limit: 1 })).entries[0]!.mergedFrom).toHaveLength(1);
      // Fast-forward: main is y's parent, so recording would make a cycle.
      await main.merge("y");
      expect(await main.readFile("/b")).toBe("b");
      expect((await main.listHistory({ limit: 1 })).entries[0]!.mergedFrom).toEqual([]);
    });
  });

  describe("setup", () => {
    it("leaves an unchanged trigger function alone and its DDL runs concurrently", async () => {
      const { setup, FREEZE_TRIGGER_DDL } = await import("../lib/core/setup.js");
      const xmin = async () =>
        (
          await client.query<{ xmin: string }>(
            `SELECT xmin::text AS xmin FROM pg_proc
             WHERE oid = to_regprocedure('fs_versions_refuse_frozen_write()')`,
          )
        ).rows[0]!.xmin;
      const before = await xmin();
      await setup(client, { enableFullTextSearch: false });
      expect(await xmin()).toBe(before);
      await Promise.all(
        Array.from({ length: 6 }, () => client.query(FREEZE_TRIGGER_DDL)),
      );
      expect(await xmin()).toBe(before);
    });
  });

  describe("compactHistory", () => {
    it("leaves a frozen version under a live, unfrozen parent reading through it", async () => {
      const main = open();
      await main.init();
      await main.writeFile("/a", "a1");
      const s1 = await main.fork("s");
      await s1.freeze();
      const u = await s1.fork("u");
      const result = await open().compactHistory();
      expect(result.materializedVersions).toBe(0);
      // The live overlay is intact: main's later write shows through.
      await main.writeFile("/b", "b1");
      expect(await s1.readFile("/b")).toBe("b1");
      expect(await u.readFile("/b")).toBe("b1");
    });

    it("trims an old-style chain without changing any version", async () => {
      const main = open();
      await main.init();
      await main.writeFile("/keep", "k");
      const N = 12;
      for (let i = 1; i <= N; i++) {
        const chat = await (open()).fork(`c${i}`);
        await chat.writeFile(`/f${i % 3}`, `v${i}`);
        if (i === 5) await chat.rm("/keep");
        await chat.promoteTo("main", { dropPrevious: true });
      }
      const live = await open().fork("live-fork");
      await live.writeFile("/mine", "m");
      const before = await open().listHistory({ limit: 100 });
      const ids = before.entries.map((e) => e.versionId);
      const snapshot = async () => {
        const out: string[] = [];
        for (const versionId of ids) {
          const fs = new PgFileSystem({
            db: client,
            workspaceId: WS,
            versionId,
            permissions: { read: true, write: false },
          });
          for (const e of await fs.walk("/")) {
            out.push(`${versionId}:${e.path}:${e.type === "file" ? await fs.readFile(e.path) : ""}`);
          }
        }
        out.push(...(await live.walk("/")).map((e) => `live:${e.path}`));
        return out;
      };
      const contents = await snapshot();
      const rowsBefore = await closureRows();
      expect(rowsBefore).toBeGreaterThan(N * N / 2);

      const result = await open().compactHistory();
      expect(result.materializedVersions).toBe(N); // N displaced versions
      expect(await closureRows()).toBe(rowsBefore - result.removedAncestorRows);
      expect(await closureRows()).toBeLessThan(3 * (N + 2));
      expect(await snapshot()).toEqual(contents);
      const after = await open().listHistory({ limit: 100, includeChanges: true });
      expect(after.entries.map((e) => e.versionId)).toEqual(ids);
      const full = await open().listHistory({ limit: 100, includeChanges: true });
      const pre = before.entries.length;
      expect(full.entries).toHaveLength(pre);
    });
  });
});
