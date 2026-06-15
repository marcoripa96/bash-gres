import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { Bash } from "just-bash";
import { ensureSetup } from "./global-setup.js";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import type { SqlClient } from "./helpers.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import {
  MountFs,
  type IFileSystem,
  type DirentEntry,
  type FsStat,
} from "../lib/mount/mount-fs.js";

// ---------------------------------------------------------------------------
// Pure routing tests (no database) — exercise the synthetic-tree and routing
// logic against a recording fake so we can assert the translated sub-paths.
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: unknown[];
}

/** Minimal IFileSystem that records every delegated call. */
class RecordingFs implements IFileSystem {
  calls: Call[] = [];
  constructor(private readonly allPaths: string[] = []) {}
  private rec<T>(method: string, args: unknown[], ret: T): T {
    this.calls.push({ method, args });
    return ret;
  }
  last(): Call {
    return this.calls[this.calls.length - 1]!;
  }
  async readFile(p: string): Promise<string> {
    return this.rec("readFile", [p], "");
  }
  async readFileBuffer(p: string): Promise<Uint8Array> {
    return this.rec("readFileBuffer", [p], new Uint8Array());
  }
  async writeFile(p: string, c: string | Uint8Array): Promise<void> {
    return this.rec("writeFile", [p, c], undefined);
  }
  async appendFile(p: string, c: string | Uint8Array): Promise<void> {
    return this.rec("appendFile", [p, c], undefined);
  }
  async exists(p: string): Promise<boolean> {
    return this.rec("exists", [p], true);
  }
  async stat(p: string): Promise<FsStat> {
    return this.rec("stat", [p], fileStat());
  }
  async lstat(p: string): Promise<FsStat> {
    return this.rec("lstat", [p], fileStat());
  }
  async mkdir(p: string): Promise<void> {
    return this.rec("mkdir", [p], undefined);
  }
  async readdir(p: string): Promise<string[]> {
    return this.rec("readdir", [p], []);
  }
  async readdirWithFileTypes(p: string): Promise<DirentEntry[]> {
    return this.rec("readdirWithFileTypes", [p], []);
  }
  async rm(p: string): Promise<void> {
    return this.rec("rm", [p], undefined);
  }
  async cp(s: string, d: string): Promise<void> {
    return this.rec("cp", [s, d], undefined);
  }
  async mv(s: string, d: string): Promise<void> {
    return this.rec("mv", [s, d], undefined);
  }
  resolvePath(base: string, p: string): string {
    return p;
  }
  getAllPaths(): string[] {
    return this.allPaths;
  }
  async chmod(p: string, mode: number): Promise<void> {
    return this.rec("chmod", [p, mode], undefined);
  }
  async symlink(t: string, l: string): Promise<void> {
    return this.rec("symlink", [t, l], undefined);
  }
  async link(e: string, n: string): Promise<void> {
    return this.rec("link", [e, n], undefined);
  }
  async readlink(p: string): Promise<string> {
    return this.rec("readlink", [p], "");
  }
  async realpath(p: string): Promise<string> {
    return this.rec("realpath", [p], p);
  }
  async utimes(p: string): Promise<void> {
    return this.rec("utimes", [p], undefined);
  }
}

class CodedError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

class ReaddirThrowsFs extends RecordingFs {
  constructor(private readonly errorCode: string) {
    super();
  }
  async readdir(p: string): Promise<string[]> {
    this.calls.push({ method: "readdir", args: [p] });
    throw new CodedError(this.errorCode);
  }
  async readdirWithFileTypes(p: string): Promise<DirentEntry[]> {
    this.calls.push({ method: "readdirWithFileTypes", args: [p] });
    throw new CodedError(this.errorCode);
  }
}

function fileStat(): FsStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mode: 0o644,
    size: 0,
    mtime: new Date(0),
  };
}

describe("MountFs routing (no DB)", () => {
  it("routes to the longest matching prefix and strips it", async () => {
    const home = new RecordingFs();
    const acme = new RecordingFs();
    const fs = new MountFs([
      { prefix: "/home", fs: home },
      { prefix: "/clienti/acme", fs: acme },
    ]);

    await fs.readFile("/home/chats/x.md");
    expect(home.last()).toEqual({ method: "readFile", args: ["/chats/x.md"] });

    await fs.writeFile("/clienti/acme/report.md", "data");
    expect(acme.last()).toEqual({
      method: "writeFile",
      args: ["/report.md", "data"],
    });
  });

  it("matches mount prefixes on path segment boundaries", async () => {
    const a = new RecordingFs();
    const ab = new RecordingFs();
    const fs = new MountFs([
      { prefix: "/a", fs: a },
      { prefix: "/ab", fs: ab },
    ]);

    await fs.readFile("/ab/file.txt");
    expect(ab.last()).toEqual({ method: "readFile", args: ["/file.txt"] });
    await expect(fs.readFile("/abc/file.txt")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(a.calls).toHaveLength(0);
  });

  it("maps the mount root to '/'", async () => {
    const home = new RecordingFs();
    const fs = new MountFs([{ prefix: "/home", fs: home }]);
    await fs.readdir("/home");
    expect(home.calls.some((c) => c.method === "readdir" && c.args[0] === "/"))
      .toBe(true);
  });

  it("synthesizes intermediate directories from the mount table", async () => {
    const dummy = new RecordingFs();
    const fs = new MountFs([
      { prefix: "/home", fs: dummy },
      { prefix: "/general", fs: dummy },
      { prefix: "/clienti/acme", fs: dummy },
      { prefix: "/clienti/globex", fs: dummy },
    ]);

    expect((await fs.readdir("/")).sort()).toEqual([
      "clienti",
      "general",
      "home",
    ]);
    expect((await fs.readdir("/clienti")).sort()).toEqual(["acme", "globex"]);

    const rootStat = await fs.stat("/clienti");
    expect(rootStat.isDirectory).toBe(true);
    expect(await fs.exists("/clienti")).toBe(true);
    expect(await fs.exists("/clienti/nope")).toBe(false);
  });

  it("readdirWithFileTypes reports synthetic dirs as directories", async () => {
    const dummy = new RecordingFs();
    const fs = new MountFs([{ prefix: "/clienti/acme", fs: dummy }]);
    const entries = await fs.readdirWithFileTypes("/");
    expect(entries).toEqual([
      { name: "clienti", isFile: false, isDirectory: true, isSymbolicLink: false },
    ]);
  });

  it("falls back to synthetic children only for missing backing dirs", async () => {
    const missing = new ReaddirThrowsFs("ENOENT");
    const denied = new ReaddirThrowsFs("EPERM");

    const missingView = new MountFs([
      { prefix: "/", fs: missing },
      { prefix: "/clienti/acme", fs: new RecordingFs() },
    ]);
    await expect(missingView.readdir("/clienti")).resolves.toEqual(["acme"]);
    await expect(missingView.readdirWithFileTypes("/clienti")).resolves.toEqual([
      { name: "acme", isFile: false, isDirectory: true, isSymbolicLink: false },
    ]);

    const deniedView = new MountFs([
      { prefix: "/", fs: denied },
      { prefix: "/clienti/acme", fs: new RecordingFs() },
    ]);
    await expect(deniedView.readdir("/clienti")).rejects.toMatchObject({
      code: "EPERM",
    });
    await expect(deniedView.readdirWithFileTypes("/clienti")).rejects.toMatchObject(
      { code: "EPERM" },
    );
  });

  it("enumerates synthetic and mounted backing paths", () => {
    const home = new RecordingFs(["/", "/notes.md", "/docs/readme.md"]);
    const acme = new RecordingFs(["/", "/report.md"]);
    const fs = new MountFs([
      { prefix: "/home", fs: home },
      { prefix: "/clienti/acme", fs: acme },
    ]);

    expect(fs.getAllPaths().sort()).toEqual(
      [
        "/",
        "/clienti",
        "/clienti/acme",
        "/clienti/acme/report.md",
        "/home",
        "/home/docs/readme.md",
        "/home/notes.md",
      ].sort(),
    );
  });

  it("rejects writes/reads outside any mount", async () => {
    const dummy = new RecordingFs();
    const fs = new MountFs([{ prefix: "/clienti/acme", fs: dummy }]);
    await expect(fs.readFile("/nope.txt")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // A synthetic directory is not writable.
    await expect(fs.writeFile("/clienti/x.txt", "y")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile("/clienti")).rejects.toMatchObject({
      code: "EISDIR",
    });
    // Mount points / synthetic dirs cannot be removed.
    await expect(fs.rm("/clienti", { recursive: true })).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("rejects duplicate mount prefixes and empty mount lists", () => {
    const dummy = new RecordingFs();
    expect(
      () =>
        new MountFs([
          { prefix: "/a", fs: dummy },
          { prefix: "/a/", fs: dummy },
        ]),
    ).toThrow(/duplicate mount prefix/);
    expect(() => new MountFs([])).toThrow(/at least one mount/);
  });

  it("resolvePath normalizes against a base", () => {
    const fs = new MountFs([{ prefix: "/a", fs: new RecordingFs() }]);
    expect(fs.resolvePath("/a/b", "c")).toBe("/a/b/c");
    expect(fs.resolvePath("/a/b", "../d")).toBe("/a/d");
    expect(fs.resolvePath("/a", "/abs")).toBe("/abs");
  });

  it("hard link across mounts is EXDEV", async () => {
    const a = new RecordingFs();
    const b = new RecordingFs();
    const fs = new MountFs([
      { prefix: "/a", fs: a },
      { prefix: "/b", fs: b },
    ]);
    await expect(fs.link("/a/x", "/b/y")).rejects.toMatchObject({
      code: "EXDEV",
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real PgFileSystem mounts over one workspace, exactly the
// "single workspace, scoped per-user view" shape from the design discussion.
// ---------------------------------------------------------------------------

const WS = "mount-fs-test";

async function seed(client: SqlClient): Promise<PgFileSystem> {
  const root = new PgFileSystem({ db: client, workspaceId: WS });
  await root.init();
  await root.mkdir("/users/u1/chats", { recursive: true });
  await root.mkdir("/users/u1/preferences", { recursive: true });
  await root.mkdir("/users/u2/chats", { recursive: true });
  await root.mkdir("/clienti/acme", { recursive: true });
  await root.mkdir("/clienti/globex", { recursive: true });
  await root.mkdir("/general", { recursive: true });
  await root.writeFile("/users/u1/chats/2026-06-15.md", "hello from u1\n");
  await root.writeFile("/users/u1/preferences/theme.txt", "dark\n");
  await root.writeFile("/users/u2/chats/2026-06-15.md", "secret u2\n");
  await root.writeFile("/clienti/acme/report.md", "acme report\n");
  await root.writeFile("/clienti/globex/data.md", "globex data\n");
  await root.writeFile("/general/policy.md", "the policy\n");
  return root;
}

/** The per-user union view: home (rw) + general (ro) + allowed clients. */
function viewForU1(client: SqlClient, allowedClients: string[]): MountFs {
  const home = new PgFileSystem({
    db: client,
    workspaceId: WS,
    rootDir: "/users/u1",
  });
  const general = new PgFileSystem({
    db: client,
    workspaceId: WS,
    rootDir: "/general",
    permissions: { read: true, write: false },
  });
  const clients = allowedClients.map((c) => ({
    prefix: `/clienti/${c}`,
    fs: new PgFileSystem({
      db: client,
      workspaceId: WS,
      rootDir: `/clienti/${c}`,
    }),
  }));
  return new MountFs([
    { prefix: "/home", fs: home },
    { prefix: "/general", fs: general },
    ...clients,
  ]);
}

describe.each(TEST_ADAPTERS)("MountFs integration [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let root: PgFileSystem;
  let fs: MountFs;

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
    root = await seed(client);
    fs = viewForU1(client, ["acme"]);
  });

  it("reads through to the owning mount", async () => {
    expect(await fs.readFile("/home/chats/2026-06-15.md")).toBe("hello from u1\n");
    expect(await fs.readFile("/home/preferences/theme.txt")).toBe("dark\n");
    expect(await fs.readFile("/general/policy.md")).toBe("the policy\n");
    expect(await fs.readFile("/clienti/acme/report.md")).toBe("acme report\n");
  });

  it("lists the synthetic root and intermediate dirs", async () => {
    expect((await fs.readdir("/")).sort()).toEqual([
      "clienti",
      "general",
      "home",
    ]);
    expect(await fs.readdir("/clienti")).toEqual(["acme"]);
    expect((await fs.readdir("/home")).sort()).toEqual(["chats", "preferences"]);
  });

  it("hides unmounted clients and other users", async () => {
    // globex is not mounted for u1, u2's home is not mounted at all.
    await expect(fs.readFile("/clienti/globex/data.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.exists("/clienti/globex")).toBe(false);
    expect(await fs.exists("/users")).toBe(false);
    await expect(fs.readFile("/users/u2/chats/2026-06-15.md")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("writes through to the home mount and is visible in the workspace", async () => {
    await fs.writeFile("/home/preferences/lang.txt", "it\n");
    expect(await fs.readFile("/home/preferences/lang.txt")).toBe("it\n");
    // Same bytes are visible at the real workspace path.
    expect(await root.readFile("/users/u1/preferences/lang.txt")).toBe("it\n");
  });

  it("enforces the read-only general mount", async () => {
    await expect(fs.writeFile("/general/policy.md", "tampered")).rejects.toMatchObject(
      { code: "EPERM" },
    );
    // The original content is untouched.
    expect(await root.readFile("/general/policy.md")).toBe("the policy\n");
  });

  it("copies across mounts (read-through)", async () => {
    await fs.cp("/general/policy.md", "/home/policy-copy.md");
    expect(await fs.readFile("/home/policy-copy.md")).toBe("the policy\n");
    expect(await root.readFile("/users/u1/policy-copy.md")).toBe("the policy\n");
  });

  it("moves a file across mounts (copy + remove)", async () => {
    await fs.mv("/home/chats/2026-06-15.md", "/clienti/acme/imported.md");
    expect(await fs.readFile("/clienti/acme/imported.md")).toBe("hello from u1\n");
    await expect(fs.readFile("/home/chats/2026-06-15.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Confirm at the real workspace paths too.
    expect(await root.readFile("/clienti/acme/imported.md")).toBe("hello from u1\n");
    expect(await root.exists("/users/u1/chats/2026-06-15.md")).toBe(false);
  });

  it("copies a directory tree across mounts with recursive", async () => {
    await fs.cp("/home/chats", "/clienti/acme/chats-backup", { recursive: true });
    expect(await fs.readFile("/clienti/acme/chats-backup/2026-06-15.md")).toBe(
      "hello from u1\n",
    );
  });

  it("moves within a single mount natively", async () => {
    await fs.mv("/home/chats/2026-06-15.md", "/home/chats/renamed.md");
    expect(await fs.readFile("/home/chats/renamed.md")).toBe("hello from u1\n");
    expect(await fs.exists("/home/chats/2026-06-15.md")).toBe(false);
  });

  it("supports symlink + readlink within a mount", async () => {
    await fs.writeFile("/home/real.txt", "target content\n");
    await fs.symlink("real.txt", "/home/link.txt");
    expect(await fs.readlink("/home/link.txt")).toBe("real.txt");
    expect(await fs.readFile("/home/link.txt")).toBe("target content\n");
  });

  it("realpath re-joins the mount prefix", async () => {
    expect(await fs.realpath("/home/chats")).toBe("/home/chats");
    expect(await fs.realpath("/clienti")).toBe("/clienti");
  });

  it("respects an expanded set of allowed clients", async () => {
    const wide = viewForU1(client, ["acme", "globex"]);
    expect(await wide.readFile("/clienti/globex/data.md")).toBe("globex data\n");
    expect((await wide.readdir("/clienti")).sort()).toEqual(["acme", "globex"]);
  });

  it("drives a real Bash session across mounts", async () => {
    const bash = new Bash({ fs });

    const cat = await bash.exec("cat /home/chats/2026-06-15.md");
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout).toBe("hello from u1\n");

    const ls = await bash.exec("ls /");
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout.split("\n").filter(Boolean).sort()).toEqual([
      "clienti",
      "general",
      "home",
    ]);

    const write = await bash.exec("echo note > /home/notes.md && cat /home/notes.md");
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toBe("note\n");

    // Read-only mount blocks writes even through the shell. just-bash may
    // surface the backing EPERM as a throw or as a non-zero exit; either way
    // the durable guarantee is that the content is left untouched.
    let blocked = false;
    try {
      const ro = await bash.exec("echo x > /general/policy.md");
      blocked = ro.exitCode !== 0;
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    expect(await root.readFile("/general/policy.md")).toBe("the policy\n");

    const grep = await bash.exec("grep policy /general/policy.md");
    expect(grep.exitCode).toBe(0);
    expect(grep.stdout).toContain("the policy");
  });
});
