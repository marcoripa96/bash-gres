import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "cherrypick-test";

describe.each(TEST_ADAPTERS)("PgFileSystem.cherryPick [%s]", (_name, factory) => {
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

  // -- File-level cherry pick ---------------------------------------------

  it("copies a single file from source", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    const exp = await main.fork("exp");
    await exp.writeFile("/file.txt", "from-exp");

    const result = await main.cherryPick("exp", ["/file.txt"]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["/file.txt"]);
    expect(result.skipped).toEqual([]);
    expect(await main.readFile("/file.txt")).toBe("from-exp");
  });

  it("overwrites destination with source content (source-wins, no conflict)", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/conf.json", `{"v":1}`);
    const b1 = await main.fork("b1");
    const b2 = await main.fork("b2");
    await b1.writeFile("/conf.json", `{"v":1-from-b1}`);
    await b2.writeFile("/conf.json", `{"v":2}`);

    // b1 cherry-picks from b2: b2's content wins, even though b1 also changed it.
    const result = await b1.cherryPick("b2", ["/conf.json"]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["/conf.json"]);
    expect(await b1.readFile("/conf.json")).toBe(`{"v":2}`);
  });

  // -- Directory cherry pick ----------------------------------------------

  it("a directory selector pulls in the whole subtree from source", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/keep.txt", "K");
    const exp = await main.fork("exp");
    await exp.mkdir("/sub", { recursive: true });
    await exp.writeFile("/sub/a.txt", "A");
    await exp.writeFile("/sub/b.txt", "B");
    await exp.writeFile("/keep.txt", "ignored-because-not-selected");

    const result = await main.cherryPick("exp", ["/sub"]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["/sub", "/sub/a.txt", "/sub/b.txt"]),
    );
    expect(result.applied).not.toContain("/keep.txt");

    expect(await main.readFile("/sub/a.txt")).toBe("A");
    expect(await main.readFile("/sub/b.txt")).toBe("B");
    // Out-of-selector paths untouched.
    expect(await main.readFile("/keep.txt")).toBe("K");
  });

  // -- Missing in source -> tombstone -------------------------------------

  it("tombstones a destination path that does not exist in source", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/gone.txt", "bye");
    const exp = await main.fork("exp");
    await exp.rm("/gone.txt");

    // /gone.txt is in main (ours) but not in exp (theirs).
    const result = await main.cherryPick("exp", ["/gone.txt"]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["/gone.txt"]);
    expect(await main.exists("/gone.txt")).toBe(false);
  });

  it("tombstones every visible descendant when a directory is selected and source does not have it", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.mkdir("/dir");
    await main.writeFile("/dir/a", "A");
    await main.writeFile("/dir/b", "B");

    const exp = await main.fork("exp");
    await exp.rm("/dir", { recursive: true });

    const result = await main.cherryPick("exp", ["/dir"]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["/dir", "/dir/a", "/dir/b"]),
    );
    expect(await main.exists("/dir")).toBe(false);
    expect(await main.exists("/dir/a")).toBe(false);
    expect(await main.exists("/dir/b")).toBe(false);
  });

  // -- Implicit parent expansion ------------------------------------------

  it("creates implicit parent directories from source", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    const exp = await main.fork("exp");
    await exp.mkdir("/a", { recursive: true });
    await exp.mkdir("/a/b", { recursive: true });
    await exp.writeFile("/a/b/c.txt", "deep");

    const result = await main.cherryPick("exp", ["/a/b/c.txt"]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["/a", "/a/b", "/a/b/c.txt"]),
    );
    expect(await main.readFile("/a/b/c.txt")).toBe("deep");
    expect((await main.stat("/a")).isDirectory).toBe(true);
    expect((await main.stat("/a/b")).isDirectory).toBe(true);
  });

  // -- Equal paths skipped -------------------------------------------------

  it("equal paths are reported in skipped, not applied", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/same.txt", "X");
    const exp = await main.fork("exp");
    // exp inherits /same.txt unchanged.

    const result = await main.cherryPick("exp", ["/same.txt"]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["/same.txt"]);
    expect(await main.readFile("/same.txt")).toBe("X");
  });

  // -- Filter scope behavior ----------------------------------------------

  it("multiple paths can be selected at once", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    const exp = await main.fork("exp");
    await exp.writeFile("/one.txt", "1");
    await exp.writeFile("/two.txt", "2");
    await exp.writeFile("/three.txt", "3");

    const result = await main.cherryPick("exp", ["/one.txt", "/three.txt"]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["/one.txt", "/three.txt"]),
    );
    expect(result.applied).not.toContain("/two.txt");
    expect(await main.exists("/two.txt")).toBe(false);
    expect(await main.readFile("/one.txt")).toBe("1");
    expect(await main.readFile("/three.txt")).toBe("3");
  });

  // -- rootDir -------------------------------------------------------------

  it("respects rootDir: paths and applied entries are user paths", async () => {
    const root = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await root.init();
    await root.mkdir("/proj");

    const main = new PgFileSystem({
      db: client,
      workspaceId: WS,
      version: "main",
      rootDir: "/proj",
    });
    await main.init();
    const exp = await main.fork("exp");
    await exp.writeFile("/file.txt", "F");

    const result = await main.cherryPick("exp", ["/file.txt"]);
    expect(result.applied).toContain("/file.txt");
    expect(await main.readFile("/file.txt")).toBe("F");
  });

  // -- Validation ----------------------------------------------------------

  it("rejects empty paths array", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.fork("exp");
    await expect(main.cherryPick("exp", [])).rejects.toThrow(/non-empty/);
  });

  it("rejects empty source label", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await expect(main.cherryPick("", ["/x"])).rejects.toThrow(/non-empty/);
  });

  it("rejects cherry-picking from current label", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await expect(main.cherryPick("main", ["/x"])).rejects.toThrow(/differ from current/);
  });

  it("rejects unknown source label", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await expect(main.cherryPick("nope", ["/x"])).rejects.toThrow(/does not exist/);
  });

  // -- Read-only -----------------------------------------------------------

  it("rejects writes from a read-only filesystem", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    const exp = await main.fork("exp");
    await exp.writeFile("/file.txt", "F");

    const ro = new PgFileSystem({
      db: client,
      workspaceId: WS,
      version: "main",
      permissions: { read: true, write: false },
    });
    await expect(ro.cherryPick("exp", ["/file.txt"])).rejects.toThrow();
  });
});
