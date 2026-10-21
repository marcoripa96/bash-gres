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
});
