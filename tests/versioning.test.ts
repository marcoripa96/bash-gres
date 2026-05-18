import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { pathToLtree } from "../lib/core/path-encoding.js";
import type { SqlClient } from "./helpers.js";

describe.each(TEST_ADAPTERS)("PgFileSystem versioning [%s]", (_name, factory) => {
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
    await resetWorkspace(client, "version-workspace");
  });

  describe("default version", () => {
    it("defaults to 'main' when version is omitted", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      expect(fs.version).toBe("main");
      await fs.init();
      await fs.writeFile("/a.txt", "hello");
      expect(await fs.readFile("/a.txt")).toBe("hello");
    });

    it("rejects an empty version string", () => {
      expect(
        () =>
          new PgFileSystem({
            db: client,
            workspaceId: "version-workspace",
            version: "",
          }),
      ).toThrow(/non-empty/);
    });
  });

  describe("version isolation", () => {
    it("writes in one version are invisible in another", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      const v2 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v2",
      });
      await v1.init();
      await v2.init();

      await v1.writeFile("/only-in-v1.txt", "v1 content");

      expect(await v1.exists("/only-in-v1.txt")).toBe(true);
      expect(await v2.exists("/only-in-v1.txt")).toBe(false);
    });

    it("same path can hold different contents across versions", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      const v2 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v2",
      });
      await v1.init();
      await v2.init();

      await v1.writeFile("/config.json", `{"env":"staging"}`);
      await v2.writeFile("/config.json", `{"env":"prod"}`);

      expect(await v1.readFile("/config.json")).toBe(`{"env":"staging"}`);
      expect(await v2.readFile("/config.json")).toBe(`{"env":"prod"}`);
    });

    it("readdir is scoped to the current version", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      const v2 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v2",
      });
      await v1.init();
      await v2.init();

      await v1.writeFile("/a.txt", "");
      await v1.writeFile("/b.txt", "");
      await v2.writeFile("/c.txt", "");

      expect(await v1.readdir("/")).toEqual(["a.txt", "b.txt"]);
      expect(await v2.readdir("/")).toEqual(["c.txt"]);
    });
  });

  describe("fork", () => {
    it("makes every file and directory visible in the forked version through ancestor overlay", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      await v1.init();
      await v1.mkdir("/src/pages", { recursive: true });
      await v1.writeFile("/src/pages/index.ts", "export default 1;");
      await v1.writeFile("/readme.md", "# hello");

      const v2 = await v1.fork("v2");

      expect(v2.version).toBe("v2");
      expect(await v2.readFile("/readme.md")).toBe("# hello");
      expect(await v2.readFile("/src/pages/index.ts")).toBe("export default 1;");
      expect(await v2.readdir("/src/pages")).toEqual(["index.ts"]);
    });

    it("divergent writes do not leak back to the source version", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      await v1.init();
      await v1.writeFile("/shared.txt", "v1 original");

      const v2 = await v1.fork("v2");
      await v2.writeFile("/shared.txt", "v2 modified");
      await v2.writeFile("/added-in-v2.txt", "new");

      expect(await v1.readFile("/shared.txt")).toBe("v1 original");
      expect(await v1.exists("/added-in-v2.txt")).toBe(false);
      expect(await v2.readFile("/shared.txt")).toBe("v2 modified");
    });

    it("rejects forking to the same version", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      await v1.init();
      await expect(v1.fork("v1")).rejects.toThrow(/differ from current/);
    });

    it("rejects forking to an existing version", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      const v2 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v2",
      });
      await v1.init();
      await v2.init();
      await expect(v1.fork("v2")).rejects.toThrow(/already exists/);
    });
  });

  describe("listVersions", () => {
    it("returns distinct versions for the workspace", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      await v1.init();
      await v1.writeFile("/a.txt", "");
      await v1.fork("v2");
      await v1.fork("v3");

      const versions = await v1.listVersions();
      expect(versions).toEqual(["v1", "v2", "v3"]);
    });
  });

  describe("deleteVersion", () => {
    it("removes only the target version's rows", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      await v1.init();
      await v1.mkdir("/deep/nested", { recursive: true });
      await v1.writeFile("/deep/nested/file.txt", "keep me");

      const v2 = await v1.fork("v2");
      await v2.writeFile("/extra.txt", "throwaway");

      await v1.deleteVersion("v2");

      expect(await v1.listVersions()).toEqual(["v1"]);
      expect(await v1.readFile("/deep/nested/file.txt")).toBe("keep me");
    });

    it("refuses to delete the current version", async () => {
      const v1 = new PgFileSystem({
        db: client,
        workspaceId: "version-workspace",
        version: "v1",
      });
      await v1.init();
      await expect(v1.deleteVersion("v1")).rejects.toThrow(/current version/);
    });
  });

  describe("versioned directories", () => {
    it("creates a scoped facade whose versions are isolated to that directory", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });

      const dbMain = await fs.versioned("/database");
      await dbMain.writeFile("/schema.sql", "main");
      const dbDraft = await dbMain.fork("draft");
      await dbDraft.writeFile("/schema.sql", "draft");
      await dbDraft.writeFile("/new.sql", "new");

      expect(await dbMain.readFile("/schema.sql")).toBe("main");
      expect(await dbMain.exists("/new.sql")).toBe(false);
      expect(await dbDraft.readFile("/schema.sql")).toBe("draft");
      expect(await dbDraft.readFile("/new.sql")).toBe("new");
      expect(await dbMain.listVersions()).toEqual(["draft", "main"]);
    });

    it("allows the same version label in different versioned directories", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });
      await fs.mkdir("/user", { versioned: true });

      const database = await fs.versioned("/database");
      const user = await fs.versioned("/user");

      await database.fork("draft");
      await user.fork("draft");

      expect(await database.listVersions()).toEqual(["draft", "main"]);
      expect(await user.listVersions()).toEqual(["draft", "main"]);
    });

    it("imports existing directory contents when making it versioned", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.writeFile("/database/schema.sql", "seed");

      await fs.mkdir("/database", { versioned: true });
      const database = await fs.versioned("/database");

      expect(await database.readFile("/schema.sql")).toBe("seed");
    });

    it("rejects scoped facades for normal directories", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/tmp");

      await expect(fs.versioned("/tmp")).rejects.toMatchObject({
        code: "ENOTVERSIONED",
      });
    });

    it("rejects nested versioned directories", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });

      await expect(
        fs.mkdir("/database/migrations", {
          recursive: true,
          versioned: true,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    });

    it("deleteVersionRoot on a versioned directory tears down the version root entirely", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });
      const database = await fs.versioned("/database");
      await database.writeFile("/schema.sql", "main");
      const draft = await database.fork("draft");
      await draft.writeFile("/schema.sql", "draft");
      await draft.writeFile("/migrations/001.sql", "migrate");

      const dbLtree = pathToLtree("/database", "version-workspace");
      const rootBefore = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree`,
        ["version-workspace", dbLtree],
      );
      expect(Number(rootBefore.rows[0]!.count)).toBe(1);

      await fs.rm("/database", { recursive: true, deleteVersionRoot: true });

      const rootAfter = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree`,
        ["version-workspace", dbLtree],
      );
      expect(Number(rootAfter.rows[0]!.count)).toBe(0);

      const orphanVersions = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM fs_versions v
         LEFT JOIN fs_version_roots r ON r.id = v.version_root_id
         WHERE v.workspace_id = $1 AND v.version_root_id IS NOT NULL AND r.id IS NULL`,
        ["version-workspace"],
      );
      expect(Number(orphanVersions.rows[0]!.count)).toBe(0);

      expect(await fs.exists("/database")).toBe(false);
      await expect(fs.versioned("/database")).rejects.toMatchObject({
        code: "ENOTVERSIONED",
      });

      await fs.mkdir("/database", { versioned: true });
      const reborn = await fs.versioned("/database");
      expect(await reborn.listVersions()).toEqual(["main"]);
      expect(await reborn.exists("/schema.sql")).toBe(false);
    });

    it("rm -r without force leaves the version root intact", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });
      const database = await fs.versioned("/database");
      await database.writeFile("/schema.sql", "main");

      await fs.rm("/database", { recursive: true });

      const dbLtree = pathToLtree("/database", "version-workspace");
      const rootAfter = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree`,
        ["version-workspace", dbLtree],
      );
      expect(Number(rootAfter.rows[0]!.count)).toBe(1);
      expect(await fs.exists("/database")).toBe(false);

      const revived = await fs.versioned("/database");
      expect(await revived.readFile("/schema.sql")).toBe("main");
    });

    it("force does not tear down a version root", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });
      const database = await fs.versioned("/database");
      await database.writeFile("/schema.sql", "main");

      await fs.rm("/database", { recursive: true, force: true });

      const revived = await fs.versioned("/database");
      expect(await revived.readFile("/schema.sql")).toBe("main");
    });

    it("deleteVersionRoot removes a hidden version root", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });
      await fs.rm("/database", { recursive: true });

      await fs.rm("/database", { recursive: true, deleteVersionRoot: true });

      await expect(fs.versioned("/database")).rejects.toMatchObject({
        code: "ENOTVERSIONED",
      });
    });

    it("requires recursive for deleteVersionRoot", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });

      await expect(
        fs.rm("/database", { deleteVersionRoot: true }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    });

    it("force never tears down the workspace root version", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.writeFile("/a.txt", "hi");

      await fs.rm("/", { recursive: true, force: true });

      const rootLtree = pathToLtree("/", "version-workspace");
      const rootRows = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree`,
        ["version-workspace", rootLtree],
      );
      expect(Number(rootRows.rows[0]!.count)).toBe(1);
      expect(await fs.exists("/a.txt")).toBe(false);
    });

    it("rm -rf on a regular directory does not touch any version root", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/database", { versioned: true });
      await fs.mkdir("/plain");
      await fs.writeFile("/plain/note.txt", "hello");

      await fs.rm("/plain", { recursive: true, force: true });

      const dbLtree = pathToLtree("/database", "version-workspace");
      const versionedStillThere = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree`,
        ["version-workspace", dbLtree],
      );
      expect(Number(versionedStillThere.rows[0]!.count)).toBe(1);
    });

    it("deleteVersionRoot rejects regular directories", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: "version-workspace" });
      await fs.init();
      await fs.mkdir("/plain");

      await expect(
        fs.rm("/plain", { recursive: true, deleteVersionRoot: true }),
      ).rejects.toMatchObject({ code: "ENOTVERSIONED" });
      expect(await fs.exists("/plain")).toBe(true);
    });
  });
});
