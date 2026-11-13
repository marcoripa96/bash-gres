import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type { SqlClient } from "./helpers.js";

const WS = "lock-order-test";

describe.each(TEST_ADAPTERS)("lock order [%s]", (_name, factory) => {
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

  /** A chat fork with two files that conflict with the published main. */
  async function diverged(): Promise<PgFileSystem> {
    const main = new PgFileSystem({
      db: client,
      workspaceId: WS,
      version: "main",
      historyRetention: "retain",
    });
    await main.init();
    await main.mkdir("/dir");
    await main.writeFile("/dir/doc.md", "# Title\n\nbody\n");
    await main.writeFile("/dir/q.sql", "select 1\n");
    const chat = await main.fork("chat");
    const other = await main.fork("other");
    await chat.writeFile("/dir/doc.md", "# Chat title\n\nbody\n");
    await chat.writeFile("/dir/q.sql", "select 2\n");
    await other.writeFile("/dir/doc.md", "# Main title\n\nbody\n");
    await other.writeFile("/dir/q.sql", "select 3\n");
    await other.promoteTo("main", { dropPrevious: true });
    return chat;
  }

  /**
   * Runs `write` on the merge's destination while the merge holds it (its
   * resolver is waiting), then lets the merge finish. Both must succeed, the
   * merge first.
   */
  async function writeDuringMerge(
    write: (writer: PgFileSystem) => Promise<unknown>,
  ): Promise<PgFileSystem> {
    const chat = await diverged();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let resolverCalled!: () => void;
    const called = new Promise<void>((r) => (resolverCalled = r));
    const order: string[] = [];
    const merging = chat
      .merge("main", {
        resolve: async () => {
          resolverCalled();
          await gate;
          return { content: "merged\n" };
        },
      })
      .then(() => order.push("merge"));
    await called;
    const writer = new PgFileSystem({ db: client, workspaceId: WS, version: "chat" });
    const writing = write(writer).then(() => order.push("write"));
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]);
    release();
    await Promise.all([merging, writing]);
    expect(order).toEqual(["merge", "write"]);
    return chat;
  }

  it("writeFile to a path the merge writes waits for the merge", async () => {
    const chat = await writeDuringMerge((w) => w.writeFile("/dir/doc.md", "from writer\n"));
    expect(await chat.readFile("/dir/doc.md")).toBe("from writer\n");
    expect(await chat.readFile("/dir/q.sql")).toBe("merged\n");
  });

  it("a transaction writing a path the merge writes waits for the merge", async () => {
    const chat = await writeDuringMerge((w) =>
      w.transaction(async (tx) => {
        await tx.writeFile("/dir/doc.md", "from tx\n");
        await tx.writeFile("/dir/q.sql", "select tx\n");
      }),
    );
    expect(await chat.readFile("/dir/doc.md")).toBe("from tx\n");
    expect(await chat.readFile("/dir/q.sql")).toBe("select tx\n");
  });

  it("rm of a path the merge writes waits for the merge", async () => {
    const chat = await writeDuringMerge((w) => w.rm("/dir/doc.md"));
    expect(await chat.exists("/dir/doc.md")).toBe(false);
  });

  it("rm -r of a directory the merge writes into waits for the merge", async () => {
    const chat = await writeDuringMerge((w) => w.rm("/dir", { recursive: true }));
    expect(await chat.exists("/dir")).toBe(false);
  });

  it("cp onto a path the merge writes waits for the merge", async () => {
    const chat = await writeDuringMerge((w) => w.cp("/dir/q.sql", "/dir/doc.md"));
    expect(await chat.exists("/dir/doc.md")).toBe(true);
  });

  it("mv onto a path the merge writes waits for the merge", async () => {
    const chat = await writeDuringMerge((w) => w.mv("/dir/q.sql", "/dir/doc.md"));
    expect(await chat.exists("/dir/q.sql")).toBe(false);
  });

  it("chmod and utimes of a path the merge writes wait for the merge", async () => {
    const chat = await writeDuringMerge(async (w) => {
      await w.chmod("/dir/doc.md", 0o600);
      await w.utimes("/dir/doc.md", new Date(0), new Date(0));
    });
    expect((await chat.stat("/dir/doc.md")).mode & 0o777).toBe(0o600);
  });

  it("a write of the content the merge stores waits for the merge", async () => {
    const chat = await writeDuringMerge((w) => w.writeFile("/same.txt", "merged\n"));
    expect(await chat.readFile("/same.txt")).toBe("merged\n");
  });

  it("setup() run from several connections at once does not deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 6 }, () => setup(client)));
    }
  });
});
