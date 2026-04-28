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

  describe("detach()", () => {
    interface ParentRow {
      parent_version_id: number | null;
    }
    interface IdRow {
      id: number;
    }

    async function getParentId(
      workspaceId: string,
      label: string,
    ): Promise<number | null> {
      const r = await client.query<ParentRow>(
        `SELECT parent_version_id FROM fs_versions
         WHERE workspace_id = $1 AND label = $2`,
        [workspaceId, label],
      );
      const v = r.rows[0]?.parent_version_id;
      return v == null ? null : Number(v);
    }

    async function getVersionId(
      workspaceId: string,
      label: string,
    ): Promise<number> {
      const r = await client.query<IdRow>(
        `SELECT id FROM fs_versions WHERE workspace_id = $1 AND label = $2`,
        [workspaceId, label],
      );
      return Number(r.rows[0]!.id);
    }

    async function ancestorIdsOf(
      workspaceId: string,
      descendantId: number,
    ): Promise<number[]> {
      const r = await client.query<{ ancestor_id: number }>(
        `SELECT ancestor_id FROM version_ancestors
         WHERE workspace_id = $1 AND descendant_id = $2
         ORDER BY ancestor_id`,
        [workspaceId, descendantId],
      );
      return r.rows.map((row) => Number(row.ancestor_id));
    }

    it("preserves the current version's visible contents byte-for-byte", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/a.txt", "AAA");
      await v1.writeFile("/dir/b.txt", "BBB");

      const v2 = await v1.fork("v2");
      await v2.writeFile("/own.txt", "v2 only");
      await v2.writeFile("/a.txt", "v2 overrides");
      await v2.rm("/dir/b.txt");

      // Capture pre-detach view.
      const before = {
        a: await v2.readFile("/a.txt"),
        own: await v2.readFile("/own.txt"),
        dirExists: await v2.exists("/dir"),
        bExists: await v2.exists("/dir/b.txt"),
      };
      expect(before).toEqual({
        a: "v2 overrides",
        own: "v2 only",
        dirExists: true,
        bExists: false,
      });

      await v2.detach();

      expect(await v2.readFile("/a.txt")).toBe("v2 overrides");
      expect(await v2.readFile("/own.txt")).toBe("v2 only");
      expect(await v2.exists("/dir")).toBe(true);
      expect(await v2.exists("/dir/b.txt")).toBe(false);
    });

    it("preserves descendants' visible contents and the effect of a current-version tombstone", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/from-v1.txt", "v1 wrote this");
      await v1.writeFile("/will-be-tombstoned.txt", "v1 wrote this too");

      const v2 = await v1.fork("v2");
      await v2.writeFile("/v2-only.txt", "v2 only");
      // Tombstone a path that lives in v1. After detach we expect v3 to keep
      // not seeing it, even though the tombstone row at v2 will be removed.
      await v2.rm("/will-be-tombstoned.txt");

      const v3 = await v2.fork("v3");
      await v3.writeFile("/v3-only.txt", "v3 only");

      // Pre-detach descendant view through v3.
      expect(await v3.readFile("/from-v1.txt")).toBe("v1 wrote this");
      expect(await v3.readFile("/v2-only.txt")).toBe("v2 only");
      expect(await v3.readFile("/v3-only.txt")).toBe("v3 only");
      expect(await v3.exists("/will-be-tombstoned.txt")).toBe(false);

      await v2.detach();

      // v3's view is byte-identical.
      expect(await v3.readFile("/from-v1.txt")).toBe("v1 wrote this");
      expect(await v3.readFile("/v2-only.txt")).toBe("v2 only");
      expect(await v3.readFile("/v3-only.txt")).toBe("v3 only");
      // The tombstone row at v2 is gone, but v3 still does not see the path:
      // v3 no longer reaches v1 through v2 after detach.
      expect(await v3.exists("/will-be-tombstoned.txt")).toBe(false);
    });

    it("clears parent_version_id on the current version and only on it", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      const v2 = await v1.fork("v2");
      const v3 = await v2.fork("v3");

      expect(await getParentId(WS, "v2")).toBe(await getVersionId(WS, "v1"));
      expect(await getParentId(WS, "v3")).toBe(await getVersionId(WS, "v2"));

      await v2.detach();

      expect(await getParentId(WS, "v2")).toBeNull();
      // Direct child v3 still points at v2.
      expect(await getParentId(WS, "v3")).toBe(await getVersionId(WS, "v2"));
      // v1 untouched.
      expect(await getParentId(WS, "v1")).toBeNull();
    });

    it("removes closure rows from the subtree to former outside ancestors and keeps inside rows", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      const v2 = await v1.fork("v2");
      await v2.fork("v3");

      const v1Id = await getVersionId(WS, "v1");
      const v2Id = await getVersionId(WS, "v2");
      const v3Id = await getVersionId(WS, "v3");

      // Pre-detach: v3's ancestors are { v3, v2, v1 }; v2's are { v2, v1 }.
      expect(await ancestorIdsOf(WS, v3Id)).toEqual([v1Id, v2Id, v3Id].sort((a, b) => a - b));
      expect(await ancestorIdsOf(WS, v2Id)).toEqual([v1Id, v2Id].sort((a, b) => a - b));

      await v2.detach();

      // Inside-subtree rows kept, outside-subtree rows removed.
      expect(await ancestorIdsOf(WS, v3Id)).toEqual([v2Id, v3Id].sort((a, b) => a - b));
      expect(await ancestorIdsOf(WS, v2Id)).toEqual([v2Id]);
      // v1's own self-row is unaffected.
      expect(await ancestorIdsOf(WS, v1Id)).toEqual([v1Id]);
    });

    it("listVersions is unchanged across detach", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      const v2 = await v1.fork("v2");
      await v2.fork("v3");

      const before = (await v1.listVersions()).sort();
      await v2.detach();
      const after = (await v1.listVersions()).sort();
      expect(after).toEqual(before);
    });

    it("makes the former ancestor deletable when no other child references it", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/inherited.txt", "from v1");

      const v2 = await v1.fork("v2");
      // While v2 is still attached, v1 cannot be deleted (it has a child).
      await expect(v2.deleteVersion("v1")).rejects.toThrow(/descendants/);

      await v2.detach();

      // Now v2 is detached and v1 has no children left, so v1 is deletable.
      await v2.deleteVersion("v1");
      expect((await v2.listVersions()).sort()).toEqual(["v2"]);

      // The materialized content survives.
      expect(await v2.readFile("/inherited.txt")).toBe("from v1");
    });

    it("keeps blob rows referenced by current visible files", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/keep-me.txt", "blob payload");

      const v2 = await v1.fork("v2");
      await v2.detach();
      // Materialization references the same blob, so we must still find it.
      expect(await v2.readFile("/keep-me.txt")).toBe("blob payload");
      // After dropping v1, the blob is still referenced by v2 and stays.
      await v2.deleteVersion("v1");
      expect(await countBlobs(client, WS)).toBeGreaterThan(0);
      expect(await v2.readFile("/keep-me.txt")).toBe("blob payload");
    });

    it("blocks live overlay: parent writes after detach do not bleed into the detached version", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/shared.txt", "before fork");

      const v2 = await v1.fork("v2");
      await v2.detach();

      // Parent writes on v1 must no longer be visible to v2.
      await v1.writeFile("/added-after-detach.txt", "parent wrote this later");
      expect(await v2.exists("/added-after-detach.txt")).toBe(false);

      // Parent edits to a path v2 inherited at fork time also stop bleeding through.
      await v1.writeFile("/shared.txt", "edited after detach");
      expect(await v2.readFile("/shared.txt")).toBe("before fork");
    });

    it("is idempotent on a root version", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/file.txt", "hi");

      // v1 already has parent_version_id=NULL; detach should be a safe no-op.
      await v1.detach();
      expect(await getParentId(WS, "v1")).toBeNull();
      expect(await v1.readFile("/file.txt")).toBe("hi");

      // Run twice to confirm idempotency.
      await v1.detach();
      expect(await v1.readFile("/file.txt")).toBe("hi");
    });

    it("detaching the middle of a chain materializes inherited content and severs only that link", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/a.txt", "from v1");
      const v2 = await v1.fork("v2");
      await v2.writeFile("/b.txt", "from v2");
      const v3 = await v2.fork("v3");
      await v3.writeFile("/c.txt", "from v3");

      await v2.detach();

      // v2 sees what it saw before, with /a.txt now materialized at v2.
      expect(await v2.readFile("/a.txt")).toBe("from v1");
      expect(await v2.readFile("/b.txt")).toBe("from v2");

      // v3's view is identical, all three paths still resolve.
      expect(await v3.readFile("/a.txt")).toBe("from v1");
      expect(await v3.readFile("/b.txt")).toBe("from v2");
      expect(await v3.readFile("/c.txt")).toBe("from v3");

      // v1 stays untouched.
      expect(await v1.readFile("/a.txt")).toBe("from v1");
    });

    it("rolls back inside a transaction that throws", async () => {
      const v1 = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await v1.init();
      await v1.writeFile("/a.txt", "from v1");

      const v2 = await v1.fork("v2");
      const v2IdBefore = await getVersionId(WS, "v2");
      const parentBefore = await getParentId(WS, "v2");
      const ancestorsBefore = await ancestorIdsOf(WS, v2IdBefore);

      await expect(
        v2.transaction(async (tx) => {
          await tx.detach();
          // Detach committed nothing yet; throw to roll back.
          throw new Error("boom");
        }),
      ).rejects.toThrow(/boom/);

      // Graph fully restored.
      expect(await getParentId(WS, "v2")).toBe(parentBefore);
      expect(await ancestorIdsOf(WS, v2IdBefore)).toEqual(ancestorsBefore);
    });
  });
});
