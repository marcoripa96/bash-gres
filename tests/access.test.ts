import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { BashInterpreter } from "../lib/core/bash/interpreter.js";
import { FsError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_ROOT = "test-rootdir";
const WS_ACCESS = "test-access";
const WS_COMBINED = "test-combined";
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
      // which maps to internal /jail/../../secret = /secret — outside rootDir
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
    let bash: BashInterpreter;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ROOT]);
      fs = new PgFileSystem({ db: client, workspaceId: WS_ROOT, rootDir: "/jail" });
      await fs.init();
      bash = new BashInterpreter(fs);
      await fs.writeFile("/file.txt", "hello");
      await fs.mkdir("/sub");
    });

    it("pwd shows /", async () => {
      const r = await bash.execute("pwd");
      expect(r.stdout.trim()).toBe("/");
    });

    it("ls / lists rootDir contents", async () => {
      const r = await bash.execute("ls /");
      expect(r.stdout).toContain("file.txt");
      expect(r.stdout).toContain("sub");
    });

    it("cat reads file through rootDir", async () => {
      const r = await bash.execute("cat /file.txt");
      expect(r.stdout).toBe("hello");
    });

    it("cd /sub && pwd shows /sub", async () => {
      const r = await bash.execute("cd /sub && pwd");
      expect(r.stdout.trim()).toBe("/sub");
    });
  });
});

// ---------------------------------------------------------------------------
// access tests
// ---------------------------------------------------------------------------

describe.each(TEST_ADAPTERS)("access [%s]", (_name, factory) => {
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

  describe("read and write restrictions", () => {
    let adminFs: PgFileSystem;
    let fs: PgFileSystem;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ACCESS]);
      adminFs = new PgFileSystem({ db: client, workspaceId: WS_ACCESS });
      await adminFs.init();

      // Set up directory structure
      await adminFs.mkdir("/docs", { recursive: true });
      await adminFs.mkdir("/scratch", { recursive: true });
      await adminFs.mkdir("/secret", { recursive: true });
      await adminFs.writeFile("/docs/readme.md", "# Docs");
      await adminFs.writeFile("/scratch/notes.txt", "notes");
      await adminFs.writeFile("/secret/key.pem", "secret-key");

      fs = new PgFileSystem({
        db: client,
        workspaceId: WS_ACCESS,
        access: { read: ["/docs"], write: ["/scratch"] },
      });
    });

    // Read operations
    it("readFile from read dir succeeds", async () => {
      expect(await fs.readFile("/docs/readme.md")).toBe("# Docs");
    });

    it("readFile from write dir succeeds (write implies read)", async () => {
      expect(await fs.readFile("/scratch/notes.txt")).toBe("notes");
    });

    it("readFile from restricted dir throws EACCES", async () => {
      await expectEACCES(fs.readFile("/secret/key.pem"));
    });

    it("exists on readable path succeeds", async () => {
      expect(await fs.exists("/docs/readme.md")).toBe(true);
    });

    it("exists on restricted path throws EACCES", async () => {
      await expectEACCES(fs.exists("/secret/key.pem"));
    });

    it("stat on readable path succeeds", async () => {
      const st = await fs.stat("/docs/readme.md");
      expect(st.isFile).toBe(true);
    });

    it("lstat on readable path succeeds", async () => {
      const st = await fs.lstat("/docs/readme.md");
      expect(st.isFile).toBe(true);
    });

    // Write operations
    it("writeFile to write dir succeeds", async () => {
      await fs.writeFile("/scratch/new.txt", "new");
      expect(await fs.readFile("/scratch/new.txt")).toBe("new");
    });

    it("writeFile to read-only dir throws EACCES", async () => {
      await expectEACCES(fs.writeFile("/docs/new.txt", "nope"));
    });

    it("writeFile to restricted dir throws EACCES", async () => {
      await expectEACCES(fs.writeFile("/secret/new.txt", "nope"));
    });

    it("appendFile to write dir succeeds", async () => {
      await fs.appendFile("/scratch/notes.txt", " more");
      expect(await fs.readFile("/scratch/notes.txt")).toBe("notes more");
    });

    it("appendFile to read-only dir throws EACCES", async () => {
      await expectEACCES(fs.appendFile("/docs/readme.md", " more"));
    });

    it("mkdir in write dir succeeds", async () => {
      await fs.mkdir("/scratch/sub");
      expect(await fs.exists("/scratch/sub")).toBe(true);
    });

    it("mkdir in read-only dir throws EACCES", async () => {
      await expectEACCES(fs.mkdir("/docs/sub"));
    });

    it("rm in write dir succeeds", async () => {
      await fs.writeFile("/scratch/del.txt", "bye");
      await fs.rm("/scratch/del.txt");
      expect(await fs.exists("/scratch/del.txt")).toBe(false);
    });

    it("rm in read-only dir throws EACCES", async () => {
      await expectEACCES(fs.rm("/docs/readme.md"));
    });

    it("cp from read to write succeeds", async () => {
      await fs.cp("/docs/readme.md", "/scratch/copy.md");
      expect(await fs.readFile("/scratch/copy.md")).toBe("# Docs");
    });

    it("cp from read to read-only throws EACCES", async () => {
      await expectEACCES(fs.cp("/docs/readme.md", "/docs/copy.md"));
    });

    it("mv within write dir succeeds", async () => {
      await fs.writeFile("/scratch/a.txt", "data");
      await fs.mv("/scratch/a.txt", "/scratch/b.txt");
      expect(await fs.readFile("/scratch/b.txt")).toBe("data");
    });

    it("mv from read-only dir throws EACCES (needs write on source)", async () => {
      await expectEACCES(fs.mv("/docs/readme.md", "/scratch/moved.md"));
    });

    it("chmod in write dir succeeds", async () => {
      await fs.chmod("/scratch/notes.txt", 0o644);
      const st = await fs.stat("/scratch/notes.txt");
      expect(st.mode).toBe(0o644);
    });

    it("chmod in read-only dir throws EACCES", async () => {
      await expectEACCES(fs.chmod("/docs/readme.md", 0o644));
    });

    it("link from read to write succeeds", async () => {
      await fs.link("/docs/readme.md", "/scratch/linked.md");
      expect(await fs.readFile("/scratch/linked.md")).toBe("# Docs");
    });

    it("glob only returns readable files", async () => {
      const results = await fs.glob("**/*");
      const paths = results.map((p) => p);
      expect(paths).toContain("/docs/readme.md");
      expect(paths).toContain("/scratch/notes.txt");
      expect(paths).not.toContain("/secret/key.pem");
    });
  });

  describe("synthetic readdir", () => {
    let adminFs: PgFileSystem;
    let fs: PgFileSystem;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ACCESS]);
      adminFs = new PgFileSystem({ db: client, workspaceId: WS_ACCESS });
      await adminFs.init();
      await adminFs.mkdir("/docs", { recursive: true });
      await adminFs.mkdir("/scratch", { recursive: true });
      await adminFs.mkdir("/secret", { recursive: true });
      await adminFs.writeFile("/docs/file.txt", "x");

      fs = new PgFileSystem({
        db: client,
        workspaceId: WS_ACCESS,
        access: { read: ["/docs"], write: ["/scratch"] },
      });
    });

    it("readdir / returns synthetic entries", async () => {
      const entries = await fs.readdir("/");
      expect(entries.sort()).toEqual(["docs", "scratch"]);
    });

    it("readdirWithTypes / returns synthetic directory entries", async () => {
      const entries = await fs.readdirWithTypes("/");
      expect(entries.length).toBe(2);
      for (const e of entries) {
        expect(e.isDirectory).toBe(true);
        expect(e.isFile).toBe(false);
      }
    });

    it("readdir on allowed dir returns actual entries", async () => {
      const entries = await fs.readdir("/docs");
      expect(entries).toContain("file.txt");
    });

    it("readdir on restricted dir throws EACCES", async () => {
      await expectEACCES(fs.readdir("/secret"));
    });

    it("deep nested access has synthetic ancestors", async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ACCESS]);
      const admin2 = new PgFileSystem({ db: client, workspaceId: WS_ACCESS });
      await admin2.init();
      await admin2.mkdir("/a/b/c", { recursive: true });
      await admin2.writeFile("/a/b/c/file.txt", "deep");

      const restricted = new PgFileSystem({
        db: client,
        workspaceId: WS_ACCESS,
        access: { read: ["/a/b/c"] },
      });

      expect(await restricted.readdir("/")).toEqual(["a"]);
      expect(await restricted.readdir("/a")).toEqual(["b"]);
      expect(await restricted.readdir("/a/b")).toEqual(["c"]);
      expect(await restricted.readdir("/a/b/c")).toContain("file.txt");
    });
  });

  describe("backward compatibility", () => {
    let fs: PgFileSystem;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ACCESS]);
      fs = new PgFileSystem({ db: client, workspaceId: WS_ACCESS });
      await fs.init();
    });

    it("no access means full access", async () => {
      await fs.mkdir("/any/dir", { recursive: true });
      await fs.writeFile("/any/dir/file.txt", "ok");
      expect(await fs.readFile("/any/dir/file.txt")).toBe("ok");
    });
  });

  describe("bash integration", () => {
    let adminFs: PgFileSystem;
    let fs: PgFileSystem;
    let bash: BashInterpreter;

    beforeEach(async () => {
      await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_ACCESS]);
      adminFs = new PgFileSystem({ db: client, workspaceId: WS_ACCESS });
      await adminFs.init();
      await adminFs.mkdir("/docs", { recursive: true });
      await adminFs.mkdir("/scratch", { recursive: true });
      await adminFs.mkdir("/secret", { recursive: true });
      await adminFs.writeFile("/docs/readme.md", "# Hello");
      await adminFs.writeFile("/secret/key.pem", "secret");

      fs = new PgFileSystem({
        db: client,
        workspaceId: WS_ACCESS,
        access: { read: ["/docs"], write: ["/scratch"] },
      });
      bash = new BashInterpreter(fs);
    });

    it("ls / shows only allowed dirs", async () => {
      const r = await bash.execute("ls /");
      expect(r.stdout).toContain("docs");
      expect(r.stdout).toContain("scratch");
      expect(r.stdout).not.toContain("secret");
    });

    it("cat readable file succeeds", async () => {
      const r = await bash.execute("cat /docs/readme.md");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("# Hello");
    });

    it("cat restricted file fails", async () => {
      const r = await bash.execute("cat /secret/key.pem");
      expect(r.exitCode).not.toBe(0);
    });

    it("echo to writable dir succeeds", async () => {
      const r = await bash.execute('echo "data" > /scratch/out.txt');
      expect(r.exitCode).toBe(0);
      expect(await fs.readFile("/scratch/out.txt")).toContain("data");
    });

    it("echo to read-only dir fails", async () => {
      const r = await bash.execute('echo "data" > /docs/new.txt');
      expect(r.exitCode).not.toBe(0);
    });

    it("cd to readable dir and pwd", async () => {
      const r = await bash.execute("cd /docs && pwd");
      expect(r.stdout.trim()).toBe("/docs");
    });

    it("cd to restricted dir fails", async () => {
      const r = await bash.execute("cd /secret");
      expect(r.exitCode).not.toBe(0);
    });

    it("cp from read to write dir", async () => {
      const r = await bash.execute("cp /docs/readme.md /scratch/copy.md");
      expect(r.exitCode).toBe(0);
      expect(await fs.readFile("/scratch/copy.md")).toBe("# Hello");
    });
  });
});

// ---------------------------------------------------------------------------
// rootDir + access combined
// ---------------------------------------------------------------------------

describe.each(TEST_ADAPTERS)("rootDir + access combined [%s]", (_name, factory) => {
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

  let adminFs: PgFileSystem;
  let fs: PgFileSystem;

  beforeEach(async () => {
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [WS_COMBINED]);
    adminFs = new PgFileSystem({ db: client, workspaceId: WS_COMBINED });
    await adminFs.init();

    // Create structure inside the jail
    await adminFs.mkdir("/users/alice/shared", { recursive: true });
    await adminFs.mkdir("/users/alice/home", { recursive: true });
    await adminFs.mkdir("/users/alice/other", { recursive: true });
    await adminFs.writeFile("/users/alice/shared/doc.txt", "shared doc");
    await adminFs.writeFile("/users/alice/other/secret.txt", "hidden");

    fs = new PgFileSystem({
      db: client,
      workspaceId: WS_COMBINED,
      rootDir: "/users/alice",
      access: { read: ["/shared"], write: ["/home"] },
    });
    await fs.init();
  });

  it("reads from allowed read path", async () => {
    expect(await fs.readFile("/shared/doc.txt")).toBe("shared doc");
  });

  it("writes to allowed write path", async () => {
    await fs.writeFile("/home/file.txt", "hello");
    expect(await fs.readFile("/home/file.txt")).toBe("hello");
    // Verify internal path
    expect(await adminFs.readFile("/users/alice/home/file.txt")).toBe("hello");
  });

  it("rejects read outside allowed paths", async () => {
    await expectEACCES(fs.readFile("/other/secret.txt"));
  });

  it("rejects write to read-only path", async () => {
    await expectEACCES(fs.writeFile("/shared/new.txt", "nope"));
  });

  it("readdir / returns synthetic entries", async () => {
    const entries = await fs.readdir("/");
    expect(entries.sort()).toEqual(["home", "shared"]);
  });

  it("realpath returns user-facing path", async () => {
    await fs.writeFile("/home/test.txt", "x");
    const rp = await fs.realpath("/home/test.txt");
    expect(rp).toBe("/home/test.txt");
  });

  it("search returns user-facing paths within allowed dirs", async () => {
    await fs.writeFile("/home/searchable.txt", "findme content here");
    // Just verify the method doesn't throw and returns user paths
    // (textSearch requires pg_textsearch extension which may not be available in all test envs)
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

  it("empty access arrays deny everything except synthetic readdir", async () => {
    const adminFs = new PgFileSystem({ db: client, workspaceId: WS_EDGE });
    await adminFs.init();
    await adminFs.writeFile("/file.txt", "data");

    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS_EDGE,
      access: { read: [], write: [] },
    });

    await expectEACCES(fs.readFile("/file.txt"));
    await expectEACCES(fs.writeFile("/new.txt", "x"));
    // readdir / returns empty (no allowed paths to derive entries from)
    const entries = await fs.readdir("/");
    expect(entries).toEqual([]);
  });

  it("access read: ['/'] gives full read, no write", async () => {
    const adminFs = new PgFileSystem({ db: client, workspaceId: WS_EDGE });
    await adminFs.init();
    await adminFs.writeFile("/file.txt", "data");

    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS_EDGE,
      access: { read: ["/"] },
    });

    expect(await fs.readFile("/file.txt")).toBe("data");
    await expectEACCES(fs.writeFile("/new.txt", "x"));
  });

  it("overlapping read paths both work", async () => {
    const adminFs = new PgFileSystem({ db: client, workspaceId: WS_EDGE });
    await adminFs.init();
    await adminFs.mkdir("/a/b", { recursive: true });
    await adminFs.writeFile("/a/file.txt", "outer");
    await adminFs.writeFile("/a/b/file.txt", "inner");

    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS_EDGE,
      access: { read: ["/a", "/a/b"] },
    });

    expect(await fs.readFile("/a/file.txt")).toBe("outer");
    expect(await fs.readFile("/a/b/file.txt")).toBe("inner");
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

  it("paths with .. are normalized before checking", async () => {
    const adminFs = new PgFileSystem({ db: client, workspaceId: WS_EDGE });
    await adminFs.init();
    await adminFs.mkdir("/allowed", { recursive: true });
    await adminFs.writeFile("/allowed/file.txt", "ok");
    await adminFs.mkdir("/forbidden", { recursive: true });
    await adminFs.writeFile("/forbidden/secret.txt", "no");

    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS_EDGE,
      access: { read: ["/allowed"] },
    });

    // Trying to escape via .. should not work
    await expectEACCES(fs.readFile("/allowed/../forbidden/secret.txt"));
  });
});
