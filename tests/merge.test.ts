import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "merge-test";

describe.each(TEST_ADAPTERS)("PgFileSystem.merge [%s]", (_name, factory) => {
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

  // -- Clean merges (no conflicts) ----------------------------------------

  describe("clean merge", () => {
    it("applies a source-only added file", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      const exp = await main.fork("exp");
      await exp.writeFile("/new.txt", "hello");

      const result = await main.merge("exp");
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toContain("/new.txt");
      expect(await main.readFile("/new.txt")).toBe("hello");
    });

    it("applies a source modification when ours equals base", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/config.json", `{"v":1}`);
      const exp = await main.fork("exp");
      await exp.writeFile("/config.json", `{"v":2}`);

      const result = await main.merge("exp");
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toContain("/config.json");
      expect(await main.readFile("/config.json")).toBe(`{"v":2}`);
    });

    it("applies source deletion when ours equals base", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/gone.txt", "bye");
      const exp = await main.fork("exp");
      await exp.rm("/gone.txt");

      const result = await main.merge("exp");
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toContain("/gone.txt");
      expect(await main.exists("/gone.txt")).toBe(false);
    });

    it("skips ours-only change (theirs equals base)", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const branch1 = await main.fork("b1");
      const branch2 = await main.fork("b2");
      await branch1.writeFile("/a.txt", "Y");
      // branch2 leaves /a.txt alone

      const result = await branch1.merge("b2");
      expect(result.conflicts).toEqual([]);
      expect(result.applied).not.toContain("/a.txt");
      expect(result.skipped).toContain("/a.txt");
      expect(await branch1.readFile("/a.txt")).toBe("Y");
    });

    it("skips when both sides make the same change", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const b1 = await main.fork("b1");
      const b2 = await main.fork("b2");
      await b1.writeFile("/a.txt", "Y");
      await b2.writeFile("/a.txt", "Y");

      const result = await b1.merge("b2");
      expect(result.conflicts).toEqual([]);
      expect(result.applied).not.toContain("/a.txt");
      expect(result.skipped).toContain("/a.txt");
      expect(await b1.readFile("/a.txt")).toBe("Y");
    });
  });

  // -- Conflicts -----------------------------------------------------------

  describe("conflicts", () => {
    it("strategy=fail: both-modify reports conflict and writes nothing", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const b1 = await main.fork("b1");
      const b2 = await main.fork("b2");
      await b1.writeFile("/a.txt", "Y");
      await b2.writeFile("/a.txt", "Z");

      const result = await b1.merge("b2");
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.path).toBe("/a.txt");
      expect(result.conflicts[0]!.base?.blobHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.conflicts[0]!.ours?.blobHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.conflicts[0]!.theirs?.blobHash).toMatch(/^[0-9a-f]{64}$/);
      // Destination unchanged.
      expect(await b1.readFile("/a.txt")).toBe("Y");
    });

    it("strategy=ours: keeps destination, reports conflict", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const b1 = await main.fork("b1");
      const b2 = await main.fork("b2");
      await b1.writeFile("/a.txt", "Y");
      await b2.writeFile("/a.txt", "Z");

      const result = await b1.merge("b2", { strategy: "ours" });
      expect(result.conflicts).toHaveLength(1);
      expect(result.applied).not.toContain("/a.txt");
      expect(result.skipped).toContain("/a.txt");
      expect(await b1.readFile("/a.txt")).toBe("Y");
    });

    it("strategy=theirs: overwrites destination, still reports conflict", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const b1 = await main.fork("b1");
      const b2 = await main.fork("b2");
      await b1.writeFile("/a.txt", "Y");
      await b2.writeFile("/a.txt", "Z");

      const result = await b1.merge("b2", { strategy: "theirs" });
      expect(result.conflicts).toHaveLength(1);
      expect(result.applied).toContain("/a.txt");
      expect(await b1.readFile("/a.txt")).toBe("Z");
    });

    it("delete-vs-modify reports a conflict", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const b1 = await main.fork("b1");
      const b2 = await main.fork("b2");
      await b1.rm("/a.txt");
      await b2.writeFile("/a.txt", "Y");

      const result = await b1.merge("b2");
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.path).toBe("/a.txt");
      expect(result.conflicts[0]!.ours).toBeNull();
      expect(result.conflicts[0]!.theirs?.type).toBe("file");
      expect(result.conflicts[0]!.base?.type).toBe("file");
      expect(result.applied).toEqual([]);
    });
  });

  // -- Directory deletion --------------------------------------------------

  describe("directory deletion", () => {
    it("tombstones the whole subtree when source removed a directory", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.mkdir("/dir");
      await main.writeFile("/dir/a.txt", "A");
      await main.writeFile("/dir/b.txt", "B");
      await main.writeFile("/dir/c.txt", "C");

      const branch = await main.fork("branch");
      await branch.rm("/dir", { recursive: true });

      const result = await main.merge("branch");
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toEqual(
        expect.arrayContaining([
          "/dir",
          "/dir/a.txt",
          "/dir/b.txt",
          "/dir/c.txt",
        ]),
      );

      expect(await main.exists("/dir")).toBe(false);
      expect(await main.exists("/dir/a.txt")).toBe(false);
      expect(await main.exists("/dir/b.txt")).toBe(false);
      expect(await main.exists("/dir/c.txt")).toBe(false);
    });
  });

  // -- dryRun --------------------------------------------------------------

  describe("dryRun", () => {
    it("returns the same result without writing", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/keep.txt", "keep");
      const exp = await main.fork("exp");
      await exp.writeFile("/new.txt", "new");
      await exp.writeFile("/keep.txt", "modified");

      const dry = await main.merge("exp", { dryRun: true });
      const dryApplied = dry.applied.slice();
      const drySkipped = dry.skipped.slice();
      const dryConflicts = dry.conflicts.slice();

      // Destination is untouched.
      expect(await main.exists("/new.txt")).toBe(false);
      expect(await main.readFile("/keep.txt")).toBe("keep");

      const real = await main.merge("exp");
      expect(real.applied.sort()).toEqual(dryApplied.sort());
      expect(real.skipped.sort()).toEqual(drySkipped.sort());
      expect(real.conflicts).toEqual(dryConflicts);

      expect(await main.readFile("/new.txt")).toBe("new");
      expect(await main.readFile("/keep.txt")).toBe("modified");
    });
  });

  // -- Path filters --------------------------------------------------------

  describe("paths and pathScope filters", () => {
    it("paths limits the merge to a single file", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "1");
      await main.writeFile("/b.txt", "2");
      const exp = await main.fork("exp");
      await exp.writeFile("/a.txt", "1b");
      await exp.writeFile("/b.txt", "2b");

      const result = await main.merge("exp", { paths: ["/a.txt"] });
      expect(result.applied).toEqual(["/a.txt"]);
      expect(await main.readFile("/a.txt")).toBe("1b");
      // /b.txt was not in the filter, so destination keeps the original.
      expect(await main.readFile("/b.txt")).toBe("2");
    });

    it("paths with a directory entry pulls in the subtree", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.mkdir("/dir");
      await main.writeFile("/dir/a", "A");
      await main.writeFile("/dir/b", "B");
      await main.writeFile("/other", "O");
      const exp = await main.fork("exp");
      await exp.writeFile("/dir/a", "A2");
      await exp.writeFile("/dir/c", "C");
      await exp.writeFile("/other", "O2");

      const result = await main.merge("exp", { paths: ["/dir"] });
      expect(result.applied).toEqual(
        expect.arrayContaining(["/dir/a", "/dir/c"]),
      );
      expect(result.applied).not.toContain("/other");
      expect(await main.readFile("/dir/a")).toBe("A2");
      expect(await main.readFile("/dir/c")).toBe("C");
      expect(await main.readFile("/other")).toBe("O");
    });

    it("pathScope limits the merge to one subtree", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.mkdir("/x");
      await main.mkdir("/y");
      await main.writeFile("/x/a", "Xa");
      await main.writeFile("/y/a", "Ya");
      const exp = await main.fork("exp");
      await exp.writeFile("/x/a", "Xa2");
      await exp.writeFile("/y/a", "Ya2");

      const result = await main.merge("exp", { pathScope: "/x" });
      expect(result.applied).toContain("/x/a");
      expect(result.applied).not.toContain("/y/a");
      expect(await main.readFile("/x/a")).toBe("Xa2");
      expect(await main.readFile("/y/a")).toBe("Ya");
    });

    it("creates implicit parent directories when paths picks a deep file", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      const exp = await main.fork("exp");
      await exp.mkdir("/sub", { recursive: true });
      await exp.mkdir("/sub/deep", { recursive: true });
      await exp.writeFile("/sub/deep/file.txt", "F");

      const result = await main.merge("exp", {
        paths: ["/sub/deep/file.txt"],
      });
      expect(result.applied).toContain("/sub/deep/file.txt");
      expect(result.applied).toContain("/sub");
      expect(result.applied).toContain("/sub/deep");

      expect(await main.readFile("/sub/deep/file.txt")).toBe("F");
      const subStat = await main.stat("/sub");
      expect(subStat.isDirectory).toBe(true);
    });

    it("rejects pathScope that is not a visible directory in destination", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const exp = await main.fork("exp");
      await exp.writeFile("/a.txt", "Y");

      // /a.txt is a file, not a directory, in destination.
      await expect(
        main.merge("exp", { pathScope: "/a.txt" }),
      ).rejects.toThrow(/pathScope/);
    });
  });

  // -- Ancestor fast path --------------------------------------------------

  describe("ancestor source fast path", () => {
    it("merging an ancestor source into current is a no-op", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await main.writeFile("/a.txt", "X");
      const exp = await main.fork("exp");
      await exp.writeFile("/b.txt", "Y");

      const result = await exp.merge("main");
      expect(result.applied).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.skipped).toEqual([]);
      // exp's view is unchanged, both files still readable through overlay.
      expect(await exp.readFile("/a.txt")).toBe("X");
      expect(await exp.readFile("/b.txt")).toBe("Y");
    });
  });

  // -- Validation ----------------------------------------------------------

  describe("input validation", () => {
    it("rejects empty source label", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await expect(main.merge("")).rejects.toThrow(/non-empty/);
    });

    it("rejects merging the current label into itself", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await expect(main.merge("main")).rejects.toThrow(/differ from current/);
    });

    it("rejects unknown source label", async () => {
      const main = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "main",
      });
      await main.init();
      await expect(main.merge("nope")).rejects.toThrow(/does not exist/);
    });
  });
});
