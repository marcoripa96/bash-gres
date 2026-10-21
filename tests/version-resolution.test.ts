import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient, TraceEvent } from "../lib/core/types.js";

const WS = "version-resolution";
const FRESH_WS = "version-resolution-never-initialized";

describe.each(TEST_ADAPTERS)("version resolution [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let events: TraceEvent[];
  const statements = () => events.filter((e) => e.type === "query").length;

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
    await resetWorkspace(client, FRESH_WS);
    const writer = new PgFileSystem({ db: client, workspaceId: WS });
    await writer.init();
    await writer.writeFile("/a.txt", "alpha");
    await writer.fork("other");
    events = [];
  });

  it("resolves root and label in one statement on a fresh instance", async () => {
    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS,
      version: "other",
      trace: (e) => events.push(e),
    });
    expect(await fs.readFile("/a.txt")).toBe("alpha");
    expect(statements()).toBe(2); // version lookup + read
    events.length = 0;
    await fs.readFile("/a.txt");
    expect(statements()).toBe(1); // cached
  });

  it("keeps the error for a label with no live version", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, version: "nope" });
    await expect(fs.readFile("/a.txt")).rejects.toThrow(
      `Version 'nope' does not exist in workspace '${WS}'. Call init() or fork() first.`,
    );
  });

  it("keeps the error for a workspace that was never initialized", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: FRESH_WS });
    await expect(fs.readFile("/a.txt")).rejects.toThrow(
      `Version 'main' does not exist in workspace '${FRESH_WS}'. Call init() or fork() first.`,
    );
    // init() still works afterwards.
    await fs.init();
    expect(await fs.readdir("/")).toEqual([]);
  });

  it("init() on a fresh instance resolves the existing version", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, version: "other" });
    await fs.init();
    await fs.writeFile("/b.txt", "beta");
    const main = new PgFileSystem({ db: client, workspaceId: WS });
    expect(await main.exists("/b.txt")).toBe(false);
    expect(await fs.readFile("/b.txt")).toBe("beta");
  });

  describe("init()", () => {
    const ownRootRows = async (label: string) => {
      const r = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM fs_entries e
           JOIN fs_versions v ON v.workspace_id = e.workspace_id AND v.id = e.version_id
          WHERE e.workspace_id = $1 AND v.label = $2 AND nlevel(e.path) = 1`,
        [WS, label],
      );
      return r.rows[0]!.n;
    };

    it("is one read, no transaction, on an initialized workspace", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        trace: (e) => events.push(e),
      });
      await fs.init();
      const qs = events.filter((e) => e.type === "query");
      expect(qs).toHaveLength(1);
      expect(qs.every((q) => q.type === "query" && !q.transaction)).toBe(true);
      // The cached ids are usable straight away.
      events.length = 0;
      await fs.writeFile("/c.txt", "gamma");
      expect(await fs.readFile("/c.txt")).toBe("gamma");
    });

    it("still writes the root row for a fork that doesn't own one", async () => {
      expect(await ownRootRows("other")).toBe(0);
      await new PgFileSystem({ db: client, workspaceId: WS, version: "other" }).init();
      expect(await ownRootRows("other")).toBe(1);
    });

    it("still fails with EPERM on a read-only instance", async () => {
      const ro = new PgFileSystem({
        db: client,
        workspaceId: WS,
        permissions: { read: true, write: false },
      });
      await expect(ro.init()).rejects.toThrow("EPERM");
    });

    it("keeps the full path inside a transaction and with a rootDir", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.transaction((tx) => tx.init());
      const scoped = new PgFileSystem({ db: client, workspaceId: WS, rootDir: "/scoped" });
      await scoped.init();
      expect(await fs.stat("/scoped").then((s) => s.isDirectory)).toBe(true);
    });
  });

  it("walk is one statement, also under a rootDir", async () => {
    const writer = new PgFileSystem({ db: client, workspaceId: WS });
    await writer.mkdir("/scope/x", { recursive: true });
    await writer.writeFile("/scope/x/y.txt", "y");
    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS,
      rootDir: "/scope",
      trace: (e) => events.push(e),
    });
    await fs.exists("/"); // resolve and cache the version id first
    events.length = 0;
    expect(await fs.walk("/")).toMatchObject([
      { path: "/x", depth: 1, isDirectory: true },
      { path: "/x/y.txt", depth: 2, isFile: true },
    ]);
    expect(statements()).toBe(1);
  });
});
