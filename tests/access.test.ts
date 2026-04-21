import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { Bash } from "just-bash";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { FsError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_ROOT = "test-rootdir";
const WS_EDGE = "test-edge";

function expectEACCES(promise: Promise<unknown>) {
  return expect(promise).rejects.toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
}

// ---------------------------------------------------------------------------
// rootDir tests
// ---------------------------------------------------------------------------

describe.each(TEST_ADAPTERS)("rootDir [%s]", (_name, factory) => {
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

  describe("basic operations", () => {
    let fs: PgFileSystem;
    let adminFs: PgFileSystem;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ROOT]);
      adminFs = new PgFileSystem({ db: client, workspaceId: WS_ROOT });
      await adminFs.init();

      fs = new PgFileSystem({ db: client, workspaceId: WS_ROOT, rootDir: "/jail" });
      await fs.init();
    });

    it("init creates rootDir directory", async () => {
      expect(await adminFs.stat("/jail")).toEqual(
        expect.objectContaining({ isDirectory: true }),
      );
    });

    it("writeFile and readFile map through rootDir", async () => {
      await fs.writeFile("/file.txt", "hello");
      expect(await fs.readFile("/file.txt")).toBe("hello");
      // Verify it's really at /jail/file.txt internally
      expect(await adminFs.readFile("/jail/file.txt")).toBe("hello");
    });

    it("exists returns true for rootDir as /", async () => {
      expect(await fs.exists("/")).toBe(true);
    });

    it("stat works on / mapping to rootDir", async () => {
      const st = await fs.stat("/");
      expect(st.isDirectory).toBe(true);
    });

    it("mkdir creates under rootDir", async () => {
      await fs.mkdir("/sub");
      expect(await adminFs.stat("/jail/sub")).toEqual(
        expect.objectContaining({ isDirectory: true }),
      );
    });

    it("readdir of / lists rootDir contents", async () => {
      await fs.writeFile("/a.txt", "a");
      await fs.mkdir("/subdir");
      const entries = await fs.readdir("/");
      expect(entries).toContain("a.txt");
      expect(entries).toContain("subdir");
    });

    it("rm works with rootDir", async () => {
      await fs.writeFile("/del.txt", "bye");
      await fs.rm("/del.txt");
      expect(await fs.exists("/del.txt")).toBe(false);
    });

    it("cp maps both paths through rootDir", async () => {
      await fs.writeFile("/src.txt", "data");
      await fs.mkdir("/dest");
      await fs.cp("/src.txt", "/dest/copy.txt");
      expect(await fs.readFile("/dest/copy.txt")).toBe("data");
    });

    it("mv maps both paths through rootDir", async () => {
      await fs.writeFile("/old.txt", "content");
      await fs.mv("/old.txt", "/new.txt");
      expect(await fs.exists("/old.txt")).toBe(false);
      expect(await fs.readFile("/new.txt")).toBe("content");
    });

    it("realpath returns user-facing path", async () => {
      await fs.writeFile("/real.txt", "x");
      const rp = await fs.realpath("/real.txt");
      expect(rp).toBe("/real.txt");
    });

    it("glob returns user-facing paths", async () => {
      await fs.writeFile("/a.txt", "a");
      await fs.mkdir("/sub");
      await fs.writeFile("/sub/b.txt", "b");
      const results = await fs.glob("**/*.txt");
      expect(results).toContain("/a.txt");
      expect(results).toContain("/sub/b.txt");
      // Should NOT contain /jail prefix
      for (const p of results) {
        expect(p.startsWith("/jail")).toBe(false);
      }
    });

    it("chmod and utimes work through rootDir", async () => {
      await fs.writeFile("/ch.txt", "x");
      await fs.chmod("/ch.txt", 0o644);
      const st = await fs.stat("/ch.txt");
      expect(st.mode).toBe(0o644);

      const date = new Date("2025-01-01");
      await fs.utimes("/ch.txt", date, date);
      const st2 = await fs.stat("/ch.txt");
      expect(st2.mtime.getTime()).toBe(date.getTime());
    });

    it("appendFile works through rootDir", async () => {
      await fs.writeFile("/app.txt", "hello");
      await fs.appendFile("/app.txt", " world");
      expect(await fs.readFile("/app.txt")).toBe("hello world");
    });

    it("link works through rootDir", async () => {
      await fs.writeFile("/orig.txt", "content");
      await fs.link("/orig.txt", "/linked.txt");
      expect(await fs.readFile("/linked.txt")).toBe("content");
    });
  });

  describe("symlink security", () => {
    let fs: PgFileSystem;
    let adminFs: PgFileSystem;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ROOT]);
      adminFs = new PgFileSystem({ db: client, workspaceId: WS_ROOT });
      await adminFs.init();
      // Create /secret outside jail
      await adminFs.mkdir("/secret");
      await adminFs.writeFile("/secret/data.txt", "top secret");

      fs = new PgFileSystem({ db: client, workspaceId: WS_ROOT, rootDir: "/jail" });
      await fs.init();
      await fs.mkdir("/dir");
    });

    it("symlink with absolute target stays within rootDir", async () => {
      await fs.writeFile("/target.txt", "ok");
      await fs.symlink("/target.txt", "/dir/link");
      expect(await fs.readFile("/dir/link")).toBe("ok");
    });

    it("symlink escaping rootDir via relative path throws EACCES", async () => {
      await expectEACCES(
        fs.symlink("../../secret/data.txt", "/dir/escape"),
      );
    });

    it("symlink escaping rootDir via absolute path throws EACCES", async () => {
      // Absolute symlink target "/../../secret" normalizes but still within user space
      // which maps to internal /jail/../../secret = /secret, outside rootDir
      await expectEACCES(
        fs.symlink("/../../secret/data.txt", "/dir/escape"),
      );
    });
  });

  describe("backward compatibility", () => {
    let fs: PgFileSystem;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ROOT]);
      fs = new PgFileSystem({ db: client, workspaceId: WS_ROOT });
      await fs.init();
    });

    it("no rootDir means / is the root (unchanged behavior)", async () => {
      await fs.writeFile("/file.txt", "data");
      expect(await fs.readFile("/file.txt")).toBe("data");
      const rp = await fs.realpath("/file.txt");
      expect(rp).toBe("/file.txt");
    });
  });

  describe("bash integration", () => {
    let fs: PgFileSystem;
    let bash: Bash;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ROOT]);
      fs = new PgFileSystem({ db: client, workspaceId: WS_ROOT, rootDir: "/jail" });
      await fs.init();
      bash = new Bash({ fs, cwd: "/" });
      await fs.writeFile("/file.txt", "hello");
      await fs.mkdir("/sub");
    });

    it("pwd shows /", async () => {
      const r = await bash.exec("pwd");
      expect(r.stdout.trim()).toBe("/");
    });

    it("ls / lists rootDir contents", async () => {
      const r = await bash.exec("ls /");
      expect(r.stdout).toContain("file.txt");
      expect(r.stdout).toContain("sub");
    });

    it("cat reads file through rootDir", async () => {
      const r = await bash.exec("cat /file.txt");
      expect(r.stdout).toContain("hello");
    });

    it("cd /sub && pwd shows /sub", async () => {
      const r = await bash.exec("cd /sub && pwd");
      expect(r.stdout.trim()).toBe("/sub");
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe.each(TEST_ADAPTERS)("edge cases [%s]", (_name, factory) => {
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
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_EDGE]);
  });

  it("rootDir that does not yet exist is created by init", async () => {
    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS_EDGE,
      rootDir: "/deep/nested/root",
    });
    await fs.init();
    await fs.writeFile("/test.txt", "works");
    expect(await fs.readFile("/test.txt")).toBe("works");
  });
});
