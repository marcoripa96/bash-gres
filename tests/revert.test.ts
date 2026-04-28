import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "revert-test";

describe.each(TEST_ADAPTERS)("PgFileSystem.revert [%s]", (_name, factory) => {
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

  // -- Restore modified file ----------------------------------------------

  it("reverts a modified file to the target's content", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/conf.json", `{"v":1}`);
    const exp = await main.fork("exp");
    await exp.writeFile("/conf.json", `{"v":99}`);

    const result = await exp.revert("main", { paths: ["/conf.json"] });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["/conf.json"]);
    expect(await exp.readFile("/conf.json")).toBe(`{"v":1}`);
  });

  // -- Delete file not present in target ----------------------------------

  it("deletes a file that does not exist in target", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    const exp = await main.fork("exp");
    await exp.writeFile("/extra.txt", "added-in-exp");

    const result = await exp.revert("main", { paths: ["/extra.txt"] });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["/extra.txt"]);
    expect(await exp.exists("/extra.txt")).toBe(false);
  });

  // -- Restore a file deleted in current ----------------------------------

  it("restores a file that was deleted in current but exists in target", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/alive.txt", "ALIVE");
    const exp = await main.fork("exp");
    await exp.rm("/alive.txt");
    expect(await exp.exists("/alive.txt")).toBe(false);

    const result = await exp.revert("main", { paths: ["/alive.txt"] });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["/alive.txt"]);
    expect(await exp.readFile("/alive.txt")).toBe("ALIVE");
  });

  // -- Directory scope -----------------------------------------------------

  it("reverts a directory subtree, restoring and deleting descendants as needed", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.mkdir("/dir");
    await main.writeFile("/dir/keep.txt", "K");
    await main.writeFile("/dir/modify.txt", "ORIG");

    const exp = await main.fork("exp");
    await exp.writeFile("/dir/modify.txt", "MOD");
    await exp.writeFile("/dir/added.txt", "NEW");
    await exp.rm("/dir/keep.txt");

    // Outside the scope - should be untouched.
    await exp.writeFile("/outside.txt", "OUT");

    const result = await exp.revert("main", { pathScope: "/dir" });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["/dir/keep.txt", "/dir/modify.txt", "/dir/added.txt"]),
    );

    expect(await exp.readFile("/dir/keep.txt")).toBe("K");
    expect(await exp.readFile("/dir/modify.txt")).toBe("ORIG");
    expect(await exp.exists("/dir/added.txt")).toBe(false);
    // Out-of-scope unchanged.
    expect(await exp.readFile("/outside.txt")).toBe("OUT");
  });

  // -- Implicit parent expansion ------------------------------------------

  it("creates missing parent directories when restoring a deep file", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.mkdir("/a", { recursive: true });
    await main.mkdir("/a/b", { recursive: true });
    await main.writeFile("/a/b/deep.txt", "D");

    const exp = await main.fork("exp");
    await exp.rm("/a", { recursive: true });
    expect(await exp.exists("/a")).toBe(false);

    const result = await exp.revert("main", { paths: ["/a/b/deep.txt"] });
    expect(result.applied).toEqual(
      expect.arrayContaining(["/a", "/a/b", "/a/b/deep.txt"]),
    );

    expect(await exp.readFile("/a/b/deep.txt")).toBe("D");
    expect((await exp.stat("/a")).isDirectory).toBe(true);
    expect((await exp.stat("/a/b")).isDirectory).toBe(true);
  });

  // -- Whole-tree revert (no filter) --------------------------------------

  it("reverts the whole visible tree when no filter is given", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/a", "A");
    await main.writeFile("/b", "B");

    const exp = await main.fork("exp");
    await exp.writeFile("/a", "Aexp");
    await exp.writeFile("/c", "Cexp");
    await exp.rm("/b");

    const result = await exp.revert("main");
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining(["/a", "/b", "/c"]),
    );

    expect(await exp.readFile("/a")).toBe("A");
    expect(await exp.readFile("/b")).toBe("B");
    expect(await exp.exists("/c")).toBe(false);
  });

  // -- Equal paths skipped ------------------------------------------------

  it("equal paths are reported in skipped", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/same.txt", "S");
    const exp = await main.fork("exp");
    // exp inherits /same.txt unchanged via the live overlay.

    const result = await exp.revert("main", { paths: ["/same.txt"] });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["/same.txt"]);
    expect(await exp.readFile("/same.txt")).toBe("S");
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
    await main.writeFile("/file.txt", "ORIG");

    const exp = await main.fork("exp");
    await exp.writeFile("/file.txt", "MOD");

    const result = await exp.revert("main", { paths: ["/file.txt"] });
    expect(result.applied).toEqual(["/file.txt"]);
    expect(await exp.readFile("/file.txt")).toBe("ORIG");
  });

  // -- Validation ----------------------------------------------------------

  it("rejects empty target label", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await expect(main.revert("")).rejects.toThrow(/non-empty/);
  });

  it("rejects reverting to current label", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await expect(main.revert("main")).rejects.toThrow(/differ from current/);
  });

  it("rejects unknown target label", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await expect(main.revert("nope")).rejects.toThrow(/does not exist/);
  });

  // -- Read-only -----------------------------------------------------------

  it("rejects writes from a read-only filesystem", async () => {
    const main = new PgFileSystem({ db: client, workspaceId: WS, version: "main" });
    await main.init();
    await main.writeFile("/file.txt", "X");
    const exp = await main.fork("exp");
    await exp.writeFile("/file.txt", "Y");

    const ro = new PgFileSystem({
      db: client,
      workspaceId: WS,
      version: "exp",
      permissions: { read: true, write: false },
    });
    await expect(ro.revert("main", { paths: ["/file.txt"] })).rejects.toThrow();
  });
});
