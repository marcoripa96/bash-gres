import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "promote-test";

async function getVersionId(
  client: SqlClient,
  workspaceId: string,
  label: string,
): Promise<number | null> {
  const r = await client.query<{ id: number }>(
    `SELECT id FROM fs_versions WHERE workspace_id = $1 AND label = $2`,
    [workspaceId, label],
  );
  return r.rows.length > 0 ? Number(r.rows[0]!.id) : null;
}

describe.each(TEST_ADAPTERS)(
  "renameVersion() & promoteTo() [%s]",
  (_name, factory) => {
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

    // -- renameVersion ----------------------------------------------------

    describe("renameVersion()", () => {
      it("rename to an unused label updates fs.version after commit", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await fs.writeFile("/file.txt", "v1");

        const before = await getVersionId(client, WS, "main");
        const result = await fs.renameVersion("main2");

        expect(result).toEqual({ label: "main2" });
        expect(fs.version).toBe("main2");

        const labels = await fs.listVersions();
        expect(labels).toContain("main2");
        expect(labels).not.toContain("main");

        const after = await getVersionId(client, WS, "main2");
        expect(after).toBe(before);

        // The instance still reads/writes the same underlying version.
        expect(await fs.readFile("/file.txt")).toBe("v1");
      });

      it("no-op when newLabel equals current label", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        const r = await fs.renameVersion("main");
        expect(r).toEqual({ label: "main" });
        expect(fs.version).toBe("main");
      });

      it("rename to an existing label without swap throws", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        const child = await fs.fork("exp");

        await expect(child.renameVersion("main")).rejects.toThrow(
          /already used by another version/,
        );
        // No mutation happened.
        expect(child.version).toBe("exp");
        const labels = await fs.listVersions();
        expect(labels).toEqual(["exp", "main"]);
      });

      it("rename with swap displaces the existing holder", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await fs.writeFile("/main.txt", "from-main");

        const child = await fs.fork("exp");
        await child.writeFile("/exp.txt", "from-exp");

        const oldMainId = await getVersionId(client, WS, "main");
        const oldExpId = await getVersionId(client, WS, "exp");

        const result = await child.renameVersion("main", { swap: true });

        expect(result.label).toBe("main");
        expect(result.displacedLabel).toBeDefined();
        expect(result.displacedLabel).toMatch(
          /^main-prev-\d{14}-\d+$/,
        );
        expect(child.version).toBe("main");

        // ID for "exp" is now the displaced label; child's original ID is now "main".
        const nowMainId = await getVersionId(client, WS, "main");
        const displacedId = await getVersionId(
          client,
          WS,
          result.displacedLabel!,
        );
        expect(nowMainId).toBe(oldExpId);
        expect(displacedId).toBe(oldMainId);

        const labels = await fs.listVersions();
        expect(labels).toContain("main");
        expect(labels).toContain(result.displacedLabel);
      });

      it("rolling back transaction() leaves the outer instance label unchanged", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();

        await expect(
          fs.transaction(async (tx) => {
            await tx.renameVersion("renamed");
            // Inside the tx, the facade sees the new label so subsequent
            // writes target the right version.
            expect(tx.version).toBe("renamed");
            throw new Error("rollback");
          }),
        ).rejects.toThrow(/rollback/);

        // Outer instance's label is untouched after rollback.
        expect(fs.version).toBe("main");
        const labels = await fs.listVersions();
        expect(labels).toEqual(["main"]);
      });

      it("commit inside transaction() updates the outer instance label", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();

        await fs.transaction(async (tx) => {
          await tx.renameVersion("renamed");
          expect(tx.version).toBe("renamed");
        });

        expect(fs.version).toBe("renamed");
        const labels = await fs.listVersions();
        expect(labels).toEqual(["renamed"]);
      });

      it("rejects empty label", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await expect(fs.renameVersion("")).rejects.toThrow(
          /non-empty/,
        );
      });
    });

    // -- promoteTo --------------------------------------------------------

    describe("promoteTo()", () => {
      it("end-to-end: detaches, swaps label, keeps displaced when dropPrevious is false", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await fs.writeFile("/shared.txt", "from-main");

        const exp = await fs.fork("exp");
        await exp.writeFile("/extra.txt", "from-exp");
        const expId = await getVersionId(client, WS, "exp");

        const result = await exp.promoteTo("main");

        expect(result.label).toBe("main");
        expect(result.displacedLabel).toBeDefined();
        expect(result.droppedPrevious).toBe(false);
        expect(exp.version).toBe("main");

        // The promoted version owns "main" and is detached from the previous main.
        const mainId = await getVersionId(client, WS, "main");
        expect(mainId).toBe(expId);

        const parentRow = await client.query<{ parent_version_id: number | null }>(
          `SELECT parent_version_id FROM fs_versions
           WHERE workspace_id = $1 AND id = $2`,
          [WS, mainId],
        );
        expect(parentRow.rows[0]!.parent_version_id).toBeNull();

        // Both files are still visible — detach materialized inherited entries.
        expect(await exp.readFile("/shared.txt")).toBe("from-main");
        expect(await exp.readFile("/extra.txt")).toBe("from-exp");

        // The displaced previous main still exists.
        const labels = await fs.listVersions();
        expect(labels).toContain(result.displacedLabel);
      });

      it("dropPrevious: true deletes the displaced version", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await fs.writeFile("/shared.txt", "from-main");

        const exp = await fs.fork("exp");
        await exp.writeFile("/extra.txt", "from-exp");

        const result = await exp.promoteTo("main", { dropPrevious: true });

        expect(result.label).toBe("main");
        expect(result.displacedLabel).toBeUndefined();
        expect(result.droppedPrevious).toBe(true);

        const labels = await exp.listVersions();
        expect(labels).toEqual(["main"]);

        // Promoted version still has every file it had before.
        expect(await exp.readFile("/shared.txt")).toBe("from-main");
        expect(await exp.readFile("/extra.txt")).toBe("from-exp");
      });

      it("rolls back the entire promotion if deleting the previous fails (descendants)", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await fs.writeFile("/shared.txt", "from-main");

        // Give "main" a *non-exp* descendant so deleteVersion() will refuse
        // to drop the displaced previous-main holder.
        const sibling = await fs.fork("sibling");
        await sibling.writeFile("/sib.txt", "sibling");

        const exp = await fs.fork("exp");
        await exp.writeFile("/extra.txt", "from-exp");

        const beforeLabels = (await fs.listVersions()).slice();
        const beforeMainId = await getVersionId(client, WS, "main");

        await expect(
          exp.promoteTo("main", { dropPrevious: true }),
        ).rejects.toThrow(/descendants/);

        // Full rollback: labels, parentage, and instance state are unchanged.
        expect(exp.version).toBe("exp");
        const afterLabels = (await fs.listVersions()).slice();
        expect(afterLabels).toEqual(beforeLabels);
        const afterMainId = await getVersionId(client, WS, "main");
        expect(afterMainId).toBe(beforeMainId);
      });

      it("descendants of the promoted version keep their visible contents", async () => {
        const fs = new PgFileSystem({
          db: client,
          workspaceId: WS,
          version: "main",
        });
        await fs.init();
        await fs.writeFile("/m.txt", "M");

        const exp = await fs.fork("exp");
        await exp.writeFile("/e.txt", "E");

        const grand = await exp.fork("grand");
        await grand.writeFile("/g.txt", "G");

        await exp.promoteTo("main", { dropPrevious: true });

        // After dropping the original main, the grandchild can still read
        // every path it could see before promotion.
        expect(await grand.readFile("/m.txt")).toBe("M");
        expect(await grand.readFile("/e.txt")).toBe("E");
        expect(await grand.readFile("/g.txt")).toBe("G");
      });
    });
  },
);
