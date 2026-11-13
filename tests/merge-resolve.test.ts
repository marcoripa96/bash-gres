import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { textMergeResolver, type MergeConflictInput } from "../lib/core/index.js";
import type { SqlClient } from "./helpers.js";

const WS = "merge-resolve-test";

describe.each(TEST_ADAPTERS)("merge resolver, unified diff [%s]", (_name, factory) => {
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

  /**
   * DataTalk's flow: two chats fork main; one publishes (becomes main), the
   * other then merges the new main. The LCA is the old main.
   */
  async function publish(
    setup: (main: PgFileSystem) => Promise<void>,
    chatEdits: (chat: PgFileSystem) => Promise<void>,
    otherEdits: (other: PgFileSystem) => Promise<void>,
  ) {
    const main = new PgFileSystem({
      db: client,
      workspaceId: WS,
      version: "main",
      historyRetention: "retain",
    });
    await main.init();
    await setup(main);
    const chat = await main.fork("chat");
    const other = await main.fork("other");
    await chatEdits(chat);
    await otherEdits(other);
    await other.promoteTo("main", { dropPrevious: true });
    return { chat, main: other };
  }

  const diverged = () =>
    publish(
      async (m) => {
        await m.writeFile("/q.sql", "select\n  a,\n  b,\n  c\nfrom t\n");
        await m.writeFile("/doc.md", "# Title\n\nbody\n");
      },
      async (c) => {
        await c.writeFile("/q.sql", "select\n  a1,\n  b,\n  c\nfrom t\n");
        await c.writeFile("/doc.md", "# Chat title\n\nbody\n");
      },
      async (o) => {
        await o.writeFile("/q.sql", "select\n  a,\n  b,\n  c\nfrom t2\n");
        await o.writeFile("/doc.md", "# Main title\n\nbody\n");
      },
    );

  it("passes the three texts to the resolver and writes its result", async () => {
    const { chat } = await diverged();
    const seen: MergeConflictInput[] = [];
    const result = await chat.merge("main", {
      resolve: (c) => {
        seen.push(c);
        return c.path === "/doc.md" ? { content: "# Merged\n\nbody\n" } : undefined;
      },
      strategy: "ours",
    });
    expect(seen.map((c) => c.path)).toEqual(["/doc.md", "/q.sql"]);
    expect(seen[0]!.base?.content).toBe("# Title\n\nbody\n");
    expect(seen[0]!.ours?.content).toBe("# Chat title\n\nbody\n");
    expect(seen[0]!.theirs?.content).toBe("# Main title\n\nbody\n");
    expect(result.resolved).toEqual(["/doc.md"]);
    expect(result.applied).toContain("/doc.md");
    expect(result.conflicts.map((c) => c.path)).toEqual(["/q.sql"]);
    expect(await chat.readFile("/doc.md")).toBe("# Merged\n\nbody\n");
  });

  it("merges non-overlapping line changes with textMergeResolver", async () => {
    const { chat } = await diverged();
    const result = await chat.merge("main", {
      resolve: (c) =>
        c.path === "/doc.md" ? { content: "# Both\n\nbody\n" } : textMergeResolver(c),
    });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toEqual(["/doc.md", "/q.sql"]);
    expect(await chat.readFile("/q.sql")).toBe("select\n  a1,\n  b,\n  c\nfrom t2\n");
  });

  it("dryRun runs the resolver but writes nothing", async () => {
    const { chat } = await diverged();
    const result = await chat.merge("main", {
      resolve: textMergeResolver,
      strategy: "ours",
      dryRun: true,
    });
    expect(result.resolved).toEqual(["/q.sql"]);
    expect(result.conflicts.map((c) => c.path)).toEqual(["/doc.md"]);
    expect(await chat.readFile("/q.sql")).toBe("select\n  a1,\n  b,\n  c\nfrom t\n");
  });

  it("writes nothing under strategy fail when a conflict remains", async () => {
    const { chat } = await diverged();
    const result = await chat.merge("main", { resolve: textMergeResolver });
    expect(result).toMatchObject({ applied: [], skipped: [], resolved: [] });
    expect(result.conflicts.map((c) => c.path)).toEqual(["/doc.md"]);
    expect(await chat.readFile("/q.sql")).toBe("select\n  a1,\n  b,\n  c\nfrom t\n");
  });

  it("supports remove, and skips a resolution equal to ours", async () => {
    const { chat } = await diverged();
    const result = await chat.merge("main", {
      resolve: (c) =>
        c.path === "/doc.md" ? { remove: true } : { content: c.ours!.content! },
    });
    expect(result.resolved).toEqual(["/doc.md", "/q.sql"]);
    expect(result.applied).toEqual(["/doc.md"]);
    expect(result.skipped).toContain("/q.sql");
    expect(await chat.exists("/doc.md")).toBe(false);
  });

  it("offers modify/delete to the resolver, not directory conflicts", async () => {
    const { chat } = await publish(
      async (m) => {
        await m.writeFile("/a.txt", "a\n");
        await m.writeFile("/x", "file\n");
      },
      async (c) => {
        await c.rm("/a.txt");
        await c.writeFile("/x", "chat\n");
      },
      async (o) => {
        await o.writeFile("/a.txt", "a2\n");
        await o.rm("/x");
        await o.mkdir("/x");
      },
    );
    const offered: string[] = [];
    const result = await chat.merge("main", {
      resolve: (c) => {
        offered.push(c.path);
        expect(c.ours).toBeNull();
        return { content: c.theirs!.content! };
      },
      strategy: "ours",
    });
    expect(offered).toEqual(["/a.txt"]);
    expect(result.conflicts.map((c) => c.path)).toEqual(["/x"]);
    expect(await chat.readFile("/a.txt")).toBe("a2\n");
  });

  it("includeContent adds the three texts to conflicts", async () => {
    const { chat } = await diverged();
    const result = await chat.merge("main", { includeContent: true, dryRun: true });
    const doc = result.conflicts.find((c) => c.path === "/doc.md")!;
    expect(doc.baseContent).toBe("# Title\n\nbody\n");
    expect(doc.oursContent).toBe("# Chat title\n\nbody\n");
    expect(doc.theirsContent).toBe("# Main title\n\nbody\n");
    const plain = await chat.merge("main", { dryRun: true });
    expect(plain.conflicts[0]).not.toHaveProperty("baseContent");
  });

  it("rejects a malformed resolution instead of guessing", async () => {
    for (const bad of [{}, { content: undefined }, { remove: false }]) {
      const { chat } = await diverged();
      await expect(
        chat.merge("main", { resolve: () => bad as never }),
      ).rejects.toThrow(/must return \{ content: string \| Uint8Array \}/);
      expect(await chat.readFile("/doc.md")).toBe("# Chat title\n\nbody\n");
      await resetWorkspace(client, WS);
    }
  });

  it("holds concurrent writes to the destination until the merge commits", async () => {
    const { chat } = await diverged();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let resolverCalled!: () => void;
    const called = new Promise<void>((r) => (resolverCalled = r));
    const order: string[] = [];
    const merging = chat
      .merge("main", {
        resolve: async (c) => {
          resolverCalled();
          await gate;
          return textMergeResolver(c) ?? { content: "merged\n" };
        },
      })
      .then(() => order.push("merge"));
    await called;
    const writer = new PgFileSystem({ db: client, workspaceId: WS, version: "chat" });
    const writing = writer.writeFile("/other.txt", "w").then(() => order.push("write"));
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]);
    release();
    await Promise.all([merging, writing]);
    expect(order).toEqual(["merge", "write"]);
    expect(await chat.readFile("/other.txt")).toBe("w");
  });

  it("rolls back when the resolver throws", async () => {
    const { chat } = await diverged();
    await expect(
      chat.merge("main", {
        resolve: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(await chat.readFile("/doc.md")).toBe("# Chat title\n\nbody\n");
  });

  it("returns unified diffs from diff, diffVersions and versionDiff", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/q.sql", "a\nb\nc\n");
    await main.writeFile("/bin", new Uint8Array([0xff, 0xfe, 0x00]));
    await main.mkdir("/d");
    const chat = await main.fork("chat");
    await chat.writeFile("/q.sql", "a\nB\nc\n");
    await chat.writeFile("/new.sql", "n\n");
    await chat.writeFile("/bin", new Uint8Array([0xff, 0x00]));
    await chat.rm("/d", { recursive: true });

    const expected = "--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    const byPath = (es: Array<{ path: string; unifiedDiff?: string | null }>) =>
      Object.fromEntries(es.map((e) => [e.path, e.unifiedDiff]));

    const d = byPath(await main.diff("chat", { unifiedDiff: true }));
    expect(d["/q.sql"]).toBe(expected);
    expect(d["/new.sql"]).toBe("--- /dev/null\n+++ b/new.sql\n@@ -0,0 +1 @@\n+n\n");
    expect(d["/bin"]).toBeNull();
    expect(d["/d"]).toBeNull();

    const { entries } = await chat.listHistory({ limit: 2 });
    const [to, from] = entries.map((e) => e.versionId);
    const dv = await chat.diffVersions(from!, to!, { unifiedDiff: { context: 0 } });
    expect(byPath(dv)["/q.sql"]).toBe("--- a/q.sql\n+++ b/q.sql\n@@ -2 +2 @@\n-b\n+B\n");
    expect(dv[0]).not.toHaveProperty("beforeContent");

    const vd = byPath(await chat.versionDiff(to!, { unifiedDiff: true }));
    expect(vd["/q.sql"]).toBe(expected);

    const plain = await main.diff("chat");
    expect(plain[0]).not.toHaveProperty("unifiedDiff");
  });

  it("opens an exact version of a versioned directory read-only", async () => {
    const root = new PgFileSystem({ db: client, workspaceId: WS, historyRetention: "retain" });
    await root.init();
    await root.mkdir("/artifacts/a1", { recursive: true, versioned: true });
    const main = await root.versioned("/artifacts/a1");
    await main.writeFile("/app.jsx", "v1");
    const v1 = (await main.listHistory({ limit: 1 })).entries[0]!.versionId;
    const chat = await main.fork("chat");
    await chat.writeFile("/app.jsx", "v2");
    await chat.promoteTo("main", { dropPrevious: true });

    const pinned = await root.versioned("/artifacts/a1", { versionId: v1 });
    expect(await pinned.readFile("/app.jsx")).toBe("v1");
    await expect(pinned.writeFile("/app.jsx", "x")).rejects.toMatchObject({ code: "EPERM" });

    await root.mkdir("/artifacts/a2", { versioned: true });
    const other = await root.versioned("/artifacts/a2", { versionId: v1 });
    await expect(other.readFile("/app.jsx")).rejects.toThrow(/does not exist in version root/);
  });
});
