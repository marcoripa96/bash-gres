import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

describe.each(TEST_ADAPTERS)("PgFileSystem sharedMounts [%s]", (_name, factory) => {
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
    await resetWorkspace(client, "mount-user");
    await resetWorkspace(client, "mount-global");
  });

  async function setupGlobal(): Promise<PgFileSystem> {
    const globalFs = new PgFileSystem({ db: client, workspaceId: "mount-global" });
    await globalFs.init();
    await globalFs.writeFile("/index.md", "# Global Index");
    await globalFs.mkdir("/topics", { recursive: true });
    await globalFs.writeFile("/topics/intro.md", "Introduction");
    await globalFs.writeFile("/topics/advanced.md", "Advanced");
    await globalFs.mkdir("/clients/client-x", { recursive: true });
    await globalFs.writeFile("/clients/client-x/brief.txt", "Client X brief");
    await globalFs.mkdir("/clients/client-y", { recursive: true });
    await globalFs.writeFile("/clients/client-y/contract.pdf", "Contract Y");
    return globalFs;
  }

  function userFs(): PgFileSystem {
    return new PgFileSystem({
      db: client,
      workspaceId: "mount-user",
      sharedMounts: [
        {
          workspaceId: "mount-global",
          mounts: [
            "/index.md",
            "/topics",
            "/clients/client-x",
            { source: "/clients/client-y", target: "/my-clients/acme" },
          ],
        },
      ],
    });
  }

  describe("exists", () => {
    it("returns true for a mounted file", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/index.md")).toBe(true);
    });

    it("returns true for a mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/topics")).toBe(true);
    });

    it("returns true for a file inside a mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/topics/intro.md")).toBe(true);
    });

    it("returns true for a remapped mount target", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/my-clients/acme")).toBe(true);
    });

    it("returns true for a file inside a remapped mount", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/my-clients/acme/contract.pdf")).toBe(true);
    });

    it("returns true for a synthetic intermediate directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/my-clients")).toBe(true);
    });

    it("returns true for /clients synthetic directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/clients")).toBe(true);
    });

    it("returns false for non-existent path not covered by mounts", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.exists("/unknown.txt")).toBe(false);
    });

    it("private workspace file wins over mount", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await fs.writeFile("/index.md", "Private override");
      expect(await fs.exists("/index.md")).toBe(true);
      expect(await fs.readFile("/index.md")).toBe("Private override");
    });
  });

  describe("stat", () => {
    it("stats a mounted file", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const s = await fs.stat("/index.md");
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
    });

    it("stats a mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const s = await fs.stat("/topics");
      expect(s.isDirectory).toBe(true);
    });

    it("stats a synthetic intermediate directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const s = await fs.stat("/my-clients");
      expect(s.isDirectory).toBe(true);
    });

    it("stats a remapped mount target", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const s = await fs.stat("/my-clients/acme");
      expect(s.isDirectory).toBe(true);
    });

    it("throws ENOENT for unknown path", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await expect(fs.stat("/ghost.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("readFile", () => {
    it("reads a mounted file", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.readFile("/index.md")).toBe("# Global Index");
    });

    it("reads a file deep in a mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.readFile("/topics/intro.md")).toBe("Introduction");
    });

    it("reads a file through a remapped mount", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      expect(await fs.readFile("/my-clients/acme/contract.pdf")).toBe("Contract Y");
    });

    it("private workspace file takes precedence", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await fs.writeFile("/index.md", "Private");
      expect(await fs.readFile("/index.md")).toBe("Private");
    });

    it("throws ENOENT for non-mounted non-existent file", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await expect(fs.readFile("/not-there.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("readFileRange", () => {
    it("reads a range from a mounted file", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const chunk = await fs.readFileRange("/index.md", { offset: 2, limit: 6 });
      expect(chunk).toBe("Global");
    });
  });

  describe("readFileLines", () => {
    it("reads lines from a mounted file", async () => {
      const globalFs = new PgFileSystem({ db: client, workspaceId: "mount-global" });
      await globalFs.init();
      await globalFs.writeFile("/multi.txt", "line1\nline2\nline3");

      const fs = new PgFileSystem({
        db: client,
        workspaceId: "mount-user",
        sharedMounts: [{ workspaceId: "mount-global", mounts: ["/multi.txt"] }],
      });
      await fs.init();
      const result = await fs.readFileLines("/multi.txt", { offset: 2, limit: 1 });
      expect(result.content).toBe("line2");
      expect(result.total).toBe(3);
    });
  });

  describe("readFileBuffer", () => {
    it("reads buffer from a mounted file", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const buf = await fs.readFileBuffer("/index.md");
      expect(new TextDecoder().decode(buf)).toBe("# Global Index");
    });
  });

  describe("readdir", () => {
    it("lists children of a mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const names = await fs.readdir("/topics");
      expect(names).toContain("intro.md");
      expect(names).toContain("advanced.md");
    });

    it("includes mount-injected names in root listing", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const names = await fs.readdir("/");
      expect(names).toContain("index.md");
      expect(names).toContain("topics");
      expect(names).toContain("clients");
      expect(names).toContain("my-clients");
    });

    it("lists synthetic intermediate directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const names = await fs.readdir("/my-clients");
      expect(names).toEqual(["acme"]);
    });

    it("lists injected child under /clients", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const names = await fs.readdir("/clients");
      expect(names).toContain("client-x");
    });

    it("private files appear in readdir when directory exists in primary", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await fs.writeFile("/topics/private.md", "private note");
      const names = await fs.readdir("/topics");
      expect(names).toContain("private.md");
      expect(names).toContain("intro.md");
    });

    it("private workspace entry shadows same-name mount entry", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await fs.writeFile("/index.md", "My private index");
      const names = await fs.readdir("/");
      // index.md appears exactly once
      expect(names.filter((n) => n === "index.md").length).toBe(1);
    });
  });

  describe("readdirWithFileTypes", () => {
    it("returns correct types for mounted entries", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const entries = await fs.readdirWithFileTypes("/topics");
      const intro = entries.find((e) => e.name === "intro.md");
      expect(intro?.isFile).toBe(true);
    });

    it("returns directory type for synthetic intermediate dir", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const root = await fs.readdirWithFileTypes("/");
      const myClients = root.find((e) => e.name === "my-clients");
      expect(myClients?.isDirectory).toBe(true);
    });
  });

  describe("readdirWithStats", () => {
    it("returns stat entries for mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const entries = await fs.readdirWithStats("/topics");
      const intro = entries.find((e) => e.name === "intro.md");
      expect(intro?.isFile).toBe(true);
      expect(intro?.size).toBeGreaterThan(0);
    });
  });

  describe("walk", () => {
    it("walks a mounted directory", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const entries = await fs.walk("/topics");
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("/topics/intro.md");
      expect(paths).toContain("/topics/advanced.md");
    });

    it("walk of root includes mounted paths", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const entries = await fs.walk("/");
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("/index.md");
      expect(paths).toContain("/topics/intro.md");
      expect(paths).toContain("/clients/client-x/brief.txt");
      expect(paths).toContain("/my-clients/acme/contract.pdf");
    });

    it("walk excludes primary paths that are duplicated by mount (primary wins)", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      await fs.writeFile("/index.md", "Private index");
      const entries = await fs.walk("/");
      const indexEntries = entries.filter((e) => e.path === "/index.md");
      expect(indexEntries.length).toBe(1);
    });

    it("walk of remapped mount returns correct paths", async () => {
      await setupGlobal();
      const fs = userFs();
      await fs.init();
      const entries = await fs.walk("/my-clients/acme");
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("/my-clients/acme/contract.pdf");
    });
  });

  describe("multiple shared workspace groups", () => {
    it("mounts from two different workspaces", async () => {
      await resetWorkspace(client, "ws-a");
      await resetWorkspace(client, "ws-b");

      const wsA = new PgFileSystem({ db: client, workspaceId: "ws-a" });
      await wsA.init();
      await wsA.writeFile("/shared-a.txt", "from A");

      const wsB = new PgFileSystem({ db: client, workspaceId: "ws-b" });
      await wsB.init();
      await wsB.writeFile("/shared-b.txt", "from B");

      const fs = new PgFileSystem({
        db: client,
        workspaceId: "mount-user",
        sharedMounts: [
          { workspaceId: "ws-a", mounts: ["/shared-a.txt"] },
          { workspaceId: "ws-b", mounts: ["/shared-b.txt"] },
        ],
      });
      await fs.init();

      expect(await fs.readFile("/shared-a.txt")).toBe("from A");
      expect(await fs.readFile("/shared-b.txt")).toBe("from B");

      await resetWorkspace(client, "ws-a");
      await resetWorkspace(client, "ws-b");
    });
  });

  describe("string vs object mount syntax", () => {
    it("string shorthand sets source = target", async () => {
      const globalFs = new PgFileSystem({ db: client, workspaceId: "mount-global" });
      await globalFs.init();
      await globalFs.writeFile("/note.txt", "hello");

      const fs = new PgFileSystem({
        db: client,
        workspaceId: "mount-user",
        sharedMounts: [{ workspaceId: "mount-global", mounts: ["/note.txt"] }],
      });
      await fs.init();
      expect(await fs.readFile("/note.txt")).toBe("hello");
    });

    it("object with target renames the mount path", async () => {
      const globalFs = new PgFileSystem({ db: client, workspaceId: "mount-global" });
      await globalFs.init();
      await globalFs.writeFile("/original.txt", "content");

      const fs = new PgFileSystem({
        db: client,
        workspaceId: "mount-user",
        sharedMounts: [
          {
            workspaceId: "mount-global",
            mounts: [{ source: "/original.txt", target: "/renamed.txt" }],
          },
        ],
      });
      await fs.init();
      expect(await fs.readFile("/renamed.txt")).toBe("content");
      await expect(fs.readFile("/original.txt")).rejects.toThrow("ENOENT");
    });

    it("object without target defaults to source path", async () => {
      const globalFs = new PgFileSystem({ db: client, workspaceId: "mount-global" });
      await globalFs.init();
      await globalFs.writeFile("/implicit.txt", "implicit");

      const fs = new PgFileSystem({
        db: client,
        workspaceId: "mount-user",
        sharedMounts: [
          {
            workspaceId: "mount-global",
            mounts: [{ source: "/implicit.txt" }],
          },
        ],
      });
      await fs.init();
      expect(await fs.readFile("/implicit.txt")).toBe("implicit");
    });
  });
});
