import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";
import type { VersionDiffEntry } from "../lib/core/types.js";

const WS = "diff-test";

function byPath(a: VersionDiffEntry, b: VersionDiffEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

describe.each(TEST_ADAPTERS)("PgFileSystem.diff [%s]", (_name, factory) => {
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

  describe("change classification", () => {
    it("reports an added file as before=null, after=other's entry", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      const b = await a.fork("b");
      await b.writeFile("/new.txt", "hello");

      const diff = await a.diff("b");
      expect(diff).toHaveLength(1);
      expect(diff[0]!.path).toBe("/new.txt");
      expect(diff[0]!.change).toBe("added");
      expect(diff[0]!.before).toBeNull();
      expect(diff[0]!.after?.type).toBe("file");
      expect(diff[0]!.after?.blobHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("reports a removed file as before=current's entry, after=null", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/gone.txt", "removed by b");
      const b = await a.fork("b");
      await b.rm("/gone.txt");

      const diff = await a.diff("b");
      expect(diff).toHaveLength(1);
      expect(diff[0]!.path).toBe("/gone.txt");
      expect(diff[0]!.change).toBe("removed");
      expect(diff[0]!.before?.type).toBe("file");
      expect(diff[0]!.after).toBeNull();
    });

    it("reports a content modification as `modified` with both sides populated", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/config.json", `{"env":"staging"}`);
      const b = await a.fork("b");
      await b.writeFile("/config.json", `{"env":"prod"}`);

      const diff = await a.diff("b");
      expect(diff).toHaveLength(1);
      expect(diff[0]!.change).toBe("modified");
      expect(diff[0]!.before?.blobHash).not.toBe(diff[0]!.after?.blobHash);
    });

    it("reports a file-to-symlink change as `type-changed`", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/target.txt", "real");
      await a.writeFile("/link.txt", "was a file");
      const b = await a.fork("b");
      await b.rm("/link.txt");
      await b.symlink("/target.txt", "/link.txt");

      const diff = await a.diff("b");
      const link = diff.find((d) => d.path === "/link.txt");
      expect(link?.change).toBe("type-changed");
      expect(link?.before?.type).toBe("file");
      expect(link?.after?.type).toBe("symlink");
    });

    it("reports a symlink target change as `modified`", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/t1.txt", "1");
      await a.writeFile("/t2.txt", "2");
      await a.symlink("/t1.txt", "/link");
      const b = await a.fork("b");
      await b.rm("/link");
      await b.symlink("/t2.txt", "/link");

      const diff = await a.diff("b");
      const link = diff.find((d) => d.path === "/link");
      expect(link?.change).toBe("modified");
      expect(link?.before?.symlinkTarget).toBe("/t1.txt");
      expect(link?.after?.symlinkTarget).toBe("/t2.txt");
    });

    it("reports a mode-only change as `modified`", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/script.sh", "#!/bin/sh\n");
      const b = await a.fork("b");
      await b.chmod("/script.sh", 0o755);

      const diff = await a.diff("b");
      const entry = diff.find((d) => d.path === "/script.sh");
      expect(entry?.change).toBe("modified");
      expect(entry?.before?.mode).not.toBe(entry?.after?.mode);
      expect(entry?.before?.blobHash).toBe(entry?.after?.blobHash);
    });

    it("omits paths that are equal in both versions", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/same.txt", "unchanged");
      await a.writeFile("/also-same.txt", "unchanged");
      const b = await a.fork("b");
      // No edits in b.

      const diff = await a.diff("b");
      expect(diff).toEqual([]);
    });

    it("ignores mtime-only differences", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/a.txt", "x");
      const b = await a.fork("b");
      // Touch mtime but keep content/mode/etc identical.
      await b.utimes("/a.txt", new Date(0), new Date(123_456_789_000));

      const diff = await a.diff("b");
      expect(diff).toEqual([]);
    });
  });

  describe("sibling versions (no ancestor relationship)", () => {
    it("diffs two siblings forked from the same parent", async () => {
      const root = new PgFileSystem({ db: client, workspaceId: WS, version: "root" });
      await root.init();
      await root.writeFile("/shared.txt", "from-root");

      const left = await root.fork("left");
      const right = await root.fork("right");
      await left.writeFile("/shared.txt", "L");
      await right.writeFile("/shared.txt", "R");
      await left.writeFile("/only-left.txt", "L-extra");
      await right.writeFile("/only-right.txt", "R-extra");

      const diff = (await left.diff("right")).sort(byPath);
      expect(diff.map((d) => `${d.change}:${d.path}`)).toEqual([
        "removed:/only-left.txt",
        "added:/only-right.txt",
        "modified:/shared.txt",
      ]);
    });
  });

  describe("scoping", () => {
    it("`opts.path` limits the diff to that subtree", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.mkdir("/keep", { recursive: true });
      await a.mkdir("/ignore", { recursive: true });
      const b = await a.fork("b");
      await b.writeFile("/keep/x.txt", "in-scope");
      await b.writeFile("/ignore/y.txt", "out-of-scope");

      const diff = await a.diff("b", { path: "/keep" });
      const paths = diff.map((d) => d.path).sort();
      expect(paths).toEqual(["/keep/x.txt"]);
    });

    it("scoping to a single file path returns at most that file", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      await a.writeFile("/a.txt", "1");
      await a.writeFile("/b.txt", "1");
      const b = await a.fork("b");
      await b.writeFile("/a.txt", "2");
      await b.writeFile("/b.txt", "2");

      const diff = await a.diff("b", { path: "/a.txt" });
      expect(diff.map((d) => d.path)).toEqual(["/a.txt"]);
    });
  });

  describe("rootDir scoping", () => {
    it("returns user paths under rootDir, not internal paths", async () => {
      const init = new PgFileSystem({ db: client, workspaceId: WS });
      await init.init();
      // Create the rooted dir that the rootDir-scoped instance will see as "/".
      await init.mkdir("/proj", { recursive: true });
      const aRoot = new PgFileSystem({
        db: client,
        workspaceId: WS,
        version: "a",
        rootDir: "/proj",
      });
      await aRoot.init();
      const bRoot = await aRoot.fork("b");
      await bRoot.writeFile("/added.txt", "x");

      const diff = await aRoot.diff("b");
      expect(diff.map((d) => d.path)).toEqual(["/added.txt"]);
    });
  });

  describe("error handling", () => {
    it("rejects diff against an unknown version", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();
      await expect(fs.diff("does-not-exist")).rejects.toThrow(/does not exist/);
    });

    it("rejects an empty `other` label", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();
      await expect(fs.diff("")).rejects.toThrow(/non-empty/);
    });
  });

  describe("diffStream", () => {
    it("returns the same rows as diff() in the same order across small batches", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      const b = await a.fork("b");

      // Generate enough divergence to span multiple batches.
      for (let i = 0; i < 25; i++) {
        await b.writeFile(`/file-${String(i).padStart(2, "0")}.txt`, `content-${i}`);
      }

      const flat = await a.diff("b");
      const streamed: VersionDiffEntry[] = [];
      for await (const e of a.diffStream("b", { batchSize: 7 })) {
        streamed.push(e);
      }

      expect(streamed.map((d) => d.path)).toEqual(flat.map((d) => d.path));
      expect(streamed.map((d) => d.change)).toEqual(flat.map((d) => d.change));
    });

    it("clamps batchSize and still terminates on small diffs", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS, version: "a" });
      await a.init();
      const b = await a.fork("b");
      await b.writeFile("/only.txt", "x");

      const collected: VersionDiffEntry[] = [];
      for await (const e of a.diffStream("b", { batchSize: 100_000 })) {
        collected.push(e);
      }
      expect(collected.map((d) => d.path)).toEqual(["/only.txt"]);
    });
  });
});
