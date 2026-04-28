import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "cow-test";
const WS_OTHER = "cow-test-other";

interface CountRow {
  count: number;
}

async function countEntries(
  client: SqlClient,
  workspaceId: string,
  versionLabel?: string,
): Promise<number> {
  if (versionLabel === undefined) {
    const r = await client.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM fs_entries WHERE workspace_id = $1`,
      [workspaceId],
    );
    return Number(r.rows[0]?.count ?? 0);
  }
  const r = await client.query<CountRow>(
    `SELECT COUNT(*)::int AS count
     FROM fs_entries e
     JOIN fs_versions v ON v.id = e.version_id
     WHERE e.workspace_id = $1 AND v.label = $2`,
    [workspaceId, versionLabel],
  );
  return Number(r.rows[0]?.count ?? 0);
}

async function countBlobs(
  client: SqlClient,
  workspaceId: string,
): Promise<number> {
  const r = await client.query<CountRow>(
    `SELECT COUNT(*)::int AS count FROM fs_blobs WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

async function countAncestors(
  client: SqlClient,
  workspaceId: string,
): Promise<number> {
  const r = await client.query<CountRow>(
    `SELECT COUNT(*)::int AS count FROM version_ancestors WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

describe.each(TEST_ADAPTERS)("COW semantics [%s]", (_name, factory) => {
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
    await resetWorkspace(client, WS_OTHER);
  });

  describe("fork is O(1)", () => {
    it("does not copy fs_entries rows when forking", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();

      // Seed many files at v1
      for (let i = 0; i < 25; i++) {
        await v1.writeFile(`/file-${i}.txt`, `content-${i}`);
      }

      const entriesBeforeFork = await countEntries(client, WS);
      await v1.fork("v2");
      const entriesAfterFork = await countEntries(client, WS);

      // Fork must not insert any new fs_entries rows.
      expect(entriesAfterFork).toBe(entriesBeforeFork);
    });

    it("populates the closure table with depth-incremented ancestors plus self", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();

      // v1 is a root, so its closure has 1 row: (v1, v1, 0).
      // After fork v2, closure has v1's 1 row + v2's 2 rows (self + parent at depth 1) = 3 total.
      // After fork v3 from v2, closure has v1(1) + v2(2) + v3(3) = 6 total.
      await v1.fork("v2");
      const v2 = new PgFileSystem({ db: client, workspaceId: WS, version: "v2" });
      await v2.fork("v3");

      expect(await countAncestors(client, WS)).toBe(6);
    });
  });

  describe("within-workspace dedup", () => {
    it("two writes of identical content share a single blob row", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      await fs.writeFile("/a.txt", "shared content");
      await fs.writeFile("/b.txt", "shared content");

      expect(await countBlobs(client, WS)).toBe(1);
    });

    it("cp does not create a new blob (shares blob_hash)", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      await fs.writeFile("/src.txt", "content");
      const blobsBefore = await countBlobs(client, WS);
      await fs.cp("/src.txt", "/dst.txt");
      const blobsAfter = await countBlobs(client, WS);

      expect(blobsAfter).toBe(blobsBefore);
      expect(await fs.readFile("/dst.txt")).toBe("content");
    });

    it("link does not create a new blob (shares blob_hash)", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      await fs.writeFile("/src.txt", "content");
      const blobsBefore = await countBlobs(client, WS);
      await fs.link("/src.txt", "/dst.txt");
      const blobsAfter = await countBlobs(client, WS);

      expect(blobsAfter).toBe(blobsBefore);
      expect(await fs.readFile("/dst.txt")).toBe("content");
    });

    it("forked write of identical content does not duplicate the blob", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/x.txt", "same");
      const v2 = await v1.fork("v2");
      await v2.writeFile("/y.txt", "same");

      expect(await countBlobs(client, WS)).toBe(1);
    });
  });

  describe("cross-workspace isolation", () => {
    it("identical content in two workspaces creates two separate blob rows", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS });
      const b = new PgFileSystem({ db: client, workspaceId: WS_OTHER });
      await a.init();
      await b.init();

      await a.writeFile("/x.txt", "shared bytes");
      await b.writeFile("/x.txt", "shared bytes");

      expect(await countBlobs(client, WS)).toBe(1);
      expect(await countBlobs(client, WS_OTHER)).toBe(1);
    });

    it("workspace A cannot see workspace B's entries", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS });
      const b = new PgFileSystem({ db: client, workspaceId: WS_OTHER });
      await a.init();
      await b.init();

      await a.writeFile("/secret.txt", "A's secret");
      await b.writeFile("/secret.txt", "B's secret");

      expect(await a.readFile("/secret.txt")).toBe("A's secret");
      expect(await b.readFile("/secret.txt")).toBe("B's secret");
    });
  });

  describe("tombstone semantics", () => {
    it("rm in child does not remove the file in the parent version", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/keep.txt", "in v1");

      const v2 = await v1.fork("v2");
      await v2.rm("/keep.txt");

      expect(await v1.exists("/keep.txt")).toBe(true);
      expect(await v1.readFile("/keep.txt")).toBe("in v1");
      expect(await v2.exists("/keep.txt")).toBe(false);
    });

    it("recursive rm in child tombstones whole subtree without touching parent", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.mkdir("/dir/sub", { recursive: true });
      await v1.writeFile("/dir/a.txt", "1");
      await v1.writeFile("/dir/sub/b.txt", "2");

      const v2 = await v1.fork("v2");
      await v2.rm("/dir", { recursive: true });

      expect(await v1.exists("/dir/a.txt")).toBe(true);
      expect(await v1.exists("/dir/sub/b.txt")).toBe(true);
      expect(await v2.exists("/dir")).toBe(false);
      expect(await v2.exists("/dir/a.txt")).toBe(false);
      expect(await v2.exists("/dir/sub/b.txt")).toBe(false);
    });

    it("re-creating a tombstoned path makes it visible again", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/x.txt", "first");
      const v2 = await v1.fork("v2");
      await v2.rm("/x.txt");
      expect(await v2.exists("/x.txt")).toBe(false);
      await v2.writeFile("/x.txt", "second");
      expect(await v2.readFile("/x.txt")).toBe("second");
      // v1 still untouched
      expect(await v1.readFile("/x.txt")).toBe("first");
    });
  });

  describe("branching", () => {
    it("two siblings forked from the same parent diverge independently", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/shared.txt", "parent");

      const left = await v1.fork("left");
      const right = await v1.fork("right");

      await left.writeFile("/shared.txt", "left wins");
      await right.writeFile("/shared.txt", "right wins");

      expect(await left.readFile("/shared.txt")).toBe("left wins");
      expect(await right.readFile("/shared.txt")).toBe("right wins");
      expect(await v1.readFile("/shared.txt")).toBe("parent");
    });

    it("grandchild inherits through the full chain", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/grandparent.txt", "from v1");
      const v2 = await v1.fork("v2");
      await v2.writeFile("/parent.txt", "from v2");
      const v3 = await v2.fork("v3");

      expect(await v3.readFile("/grandparent.txt")).toBe("from v1");
      expect(await v3.readFile("/parent.txt")).toBe("from v2");
    });
  });

  describe("deep version chains", () => {
    it("a 30-deep linear chain still resolves the original entry", async () => {
      let fs = new PgFileSystem({ db: client, workspaceId: WS, version: "v0" });
      await fs.init();
      await fs.writeFile("/origin.txt", "from v0");
      for (let i = 1; i <= 30; i++) {
        fs = await fs.fork(`v${i}`);
      }
      expect(await fs.readFile("/origin.txt")).toBe("from v0");
      // Closure size: each version stores its full ancestor chain, so total rows = sum 1..31 = 496.
      expect(await countAncestors(client, WS)).toBe((31 * 32) / 2);
    });
  });

  describe("mv preserves blob (single file)", () => {
    it("does not allocate a new blob row when renaming a file", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();
      await fs.writeFile("/src.txt", "the-bytes");
      const before = await countBlobs(client, WS);
      await fs.mv("/src.txt", "/dst.txt");
      const after = await countBlobs(client, WS);

      expect(after).toBe(before);
      expect(await fs.exists("/src.txt")).toBe(false);
      expect(await fs.readFile("/dst.txt")).toBe("the-bytes");
    });

    it("preserves blob_hash across directory mv", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();
      await fs.mkdir("/from/nested", { recursive: true });
      await fs.writeFile("/from/a.txt", "AA");
      await fs.writeFile("/from/nested/b.txt", "BB");
      const blobsBefore = await countBlobs(client, WS);
      await fs.mkdir("/dest");
      await fs.mv("/from", "/dest/moved");
      const blobsAfter = await countBlobs(client, WS);

      // Same blobs (AA, BB) reused.
      expect(blobsAfter).toBe(blobsBefore);
      expect(await fs.readFile("/dest/moved/a.txt")).toBe("AA");
      expect(await fs.readFile("/dest/moved/nested/b.txt")).toBe("BB");
      expect(await fs.exists("/from")).toBe(false);
    });
  });

  describe("GC on deleteVersion", () => {
    it("removes blobs no longer referenced after the version's entries are deleted", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/keep.txt", "keep");
      const blobsAfterV1 = await countBlobs(client, WS);

      const v2 = await v1.fork("v2");
      await v2.writeFile("/throwaway.txt", "ephemeral");
      expect(await countBlobs(client, WS)).toBe(blobsAfterV1 + 1);

      await v1.deleteVersion("v2");

      // v2's unique blob "ephemeral" is now unreferenced -> GC'd.
      expect(await countBlobs(client, WS)).toBe(blobsAfterV1);
      // v1's blob is intact.
      expect(await v1.readFile("/keep.txt")).toBe("keep");
    });

    it("does not GC a blob still referenced by another version", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/shared.txt", "still-needed");

      const v2 = await v1.fork("v2");
      // v2 inherits /shared.txt from v1; no v2 entry exists for it.

      const v3 = await v1.fork("v3");
      await v3.writeFile("/another.txt", "still-needed"); // same blob hash

      // Delete v3. Its entry for /another.txt goes away, but the blob is still
      // referenced by v1's entry for /shared.txt (same content, same hash).
      await v1.deleteVersion("v3");

      expect(await v1.readFile("/shared.txt")).toBe("still-needed");
      expect(await v2.readFile("/shared.txt")).toBe("still-needed");
    });

    it("refuses to delete a version with descendants", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      const v2 = await v1.fork("v2");
      await v2.fork("v3");

      // Delete v2 from a sibling viewpoint (v1 is the parent of v2 and ancestor of v3).
      await expect(v1.deleteVersion("v2")).rejects.toThrow(/descendants/);
    });

    it("removes closure rows for the deleted version", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.fork("v2");

      const beforeDelete = await countAncestors(client, WS);
      await v1.deleteVersion("v2");
      const afterDelete = await countAncestors(client, WS);

      // Removed v2's two closure rows (self + parent).
      expect(afterDelete).toBe(beforeDelete - 2);
    });
  });

  describe("embedding deduplication (no-vector setup)", () => {
    it("does not call embed() when no embedding column exists", async () => {
      let calls = 0;
      const embed = async (_text: string): Promise<number[]> => {
        calls++;
        return [1, 0, 0, 0];
      };
      const fs = new PgFileSystem({ db: client, workspaceId: WS, embed });
      await fs.init();
      await fs.writeFile("/a.txt", "hello");
      await fs.writeFile("/b.txt", "hello");

      // No embedding column → embed never invoked; writes succeed; dedup holds.
      expect(calls).toBe(0);
      expect(await countBlobs(client, WS)).toBe(1);
    });
  });

  describe("listVersions", () => {
    it("returns labels for both forked and root versions", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.fork("v2");
      const v3 = new PgFileSystem({ db: client, workspaceId: WS, version: "v3" });
      await v3.init();

      const labels = await v1.listVersions();
      expect(labels.sort()).toEqual(["v1", "v2", "v3"]);
    });
  });

  describe("live ancestor overlay (fork is not a snapshot)", () => {
    it("a parent write after fork is visible to the child for unshadowed paths", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/shared.txt", "before fork");

      const v2 = await v1.fork("v2");
      // Child sees the inherited row.
      expect(await v2.readFile("/shared.txt")).toBe("before fork");

      // Parent writes to a NEW path the child has not seen yet.
      await v1.writeFile("/added-after-fork.txt", "from parent");

      // Live overlay: the new parent path is visible to the child because the
      // child has no row (or tombstone) at this path that would shadow the parent.
      expect(await v2.exists("/added-after-fork.txt")).toBe(true);
      expect(await v2.readFile("/added-after-fork.txt")).toBe("from parent");

      // Parent edits an existing inherited path. The child also sees that update,
      // because the child still has no row at that path.
      await v1.writeFile("/shared.txt", "edited after fork");
      expect(await v2.readFile("/shared.txt")).toBe("edited after fork");
    });

    it("once the child writes a path, later parent writes do not change the child's view of it", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/config.txt", "v1 original");

      const v2 = await v1.fork("v2");
      await v2.writeFile("/config.txt", "v2 owns this");

      await v1.writeFile("/config.txt", "v1 changed again");

      // Child has shadowed the path; parent writes can't bleed through.
      expect(await v2.readFile("/config.txt")).toBe("v2 owns this");
      // Parent reflects its own latest write.
      expect(await v1.readFile("/config.txt")).toBe("v1 changed again");
    });

    it("a tombstone in the child shields it from later parent writes at that path", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/will-delete.txt", "v1");

      const v2 = await v1.fork("v2");
      await v2.rm("/will-delete.txt");
      expect(await v2.exists("/will-delete.txt")).toBe(false);

      // Parent re-creates the path. Child's tombstone keeps it hidden.
      await v1.writeFile("/will-delete.txt", "v1 recreated");
      expect(await v2.exists("/will-delete.txt")).toBe(false);
      expect(await v1.readFile("/will-delete.txt")).toBe("v1 recreated");
    });
  });
});
