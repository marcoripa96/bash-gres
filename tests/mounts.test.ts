import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Bash } from "just-bash";
import { ensureSetup } from "./global-setup.js";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import type { SqlClient } from "./helpers.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { hybridSearch } from "../lib/core/search.js";
import { compileMounts } from "../lib/core/mounts.js";
import type { SqlParam } from "../lib/core/types.js";

// ---------------------------------------------------------------------------
// Native mounts — a single PgFileSystem over one workspace, restricted to a set
// of subtrees. This is the "single workspace, one version graph, scoped per-user
// view" shape, expressed without a routing wrapper. Paths are the real workspace
// paths (no remapping): the agent sees /users/u1, /general, /clienti/acme.
// ---------------------------------------------------------------------------

const WS = "mounts-test";

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

/** The per-user view: own home (rw) + general (ro) + allowed clients (rw). */
function viewForU1(
  client: SqlClient,
  allowedClients: string[],
  version?: string,
): PgFileSystem {
  return new PgFileSystem({
    db: client,
    workspaceId: WS,
    version,
    mount: [
      { path: "/users/u1" },
      { path: "/general", readonly: true },
      ...allowedClients.map((c) => ({ path: `/clienti/${c}` })),
    ],
  });
}

describe.each(TEST_ADAPTERS)("native mounts [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let root: PgFileSystem;
  let fs: PgFileSystem;

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

  it("reads through to mounted subtrees", async () => {
    expect(await fs.readFile("/users/u1/chats/2026-06-15.md")).toBe("hello from u1\n");
    expect(await fs.readFile("/users/u1/preferences/theme.txt")).toBe("dark\n");
    expect(await fs.readFile("/general/policy.md")).toBe("the policy\n");
    expect(await fs.readFile("/clienti/acme/report.md")).toBe("acme report\n");
  });

  it("lists synthetic ancestors and hides unmounted siblings", async () => {
    expect((await fs.readdir("/")).sort()).toEqual(["clienti", "general", "users"]);
    expect(await fs.readdir("/users")).toEqual(["u1"]); // u2 hidden
    expect(await fs.readdir("/clienti")).toEqual(["acme"]); // globex hidden
    expect((await fs.readdir("/users/u1")).sort()).toEqual(["chats", "preferences"]);
  });

  it("readdirWithFileTypes marks ancestor passthroughs as directories", async () => {
    const top = await fs.readdirWithFileTypes("/");
    expect(top.map((e) => e.name).sort()).toEqual(["clienti", "general", "users"]);
    expect(top.every((e) => e.isDirectory)).toBe(true);
    const usersChildren = await fs.readdirWithFileTypes("/users");
    expect(usersChildren).toEqual([
      { name: "u1", isFile: false, isDirectory: true, isSymbolicLink: false },
    ]);
  });

  it("hides other users and unmounted clients (ENOENT / exists=false)", async () => {
    await expect(fs.readFile("/users/u2/chats/2026-06-15.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile("/clienti/globex/data.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.exists("/users/u2")).toBe(false);
    expect(await fs.exists("/clienti/globex")).toBe(false);
    // The ancestor passthroughs themselves are visible.
    expect(await fs.exists("/users")).toBe(true);
    expect(await fs.exists("/clienti")).toBe(true);
    await expect(fs.stat("/users/u2")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes through a rw mount and is visible at the real workspace path", async () => {
    await fs.writeFile("/users/u1/preferences/lang.txt", "it\n");
    expect(await fs.readFile("/users/u1/preferences/lang.txt")).toBe("it\n");
    expect(await root.readFile("/users/u1/preferences/lang.txt")).toBe("it\n");
  });

  it("denies writes under a readonly mount (EACCES), leaving content intact", async () => {
    await expect(fs.writeFile("/general/policy.md", "tampered")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await root.readFile("/general/policy.md")).toBe("the policy\n");
  });

  it("denies writes outside any mount", async () => {
    // Sibling of u1 — not even visible.
    await expect(fs.writeFile("/users/u2/x.txt", "y")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Unmounted client.
    await expect(fs.writeFile("/clienti/globex/x.txt", "y")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // An ancestor passthrough dir is visible but not writable.
    await expect(fs.writeFile("/users/new.txt", "y")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enforces readonly root and most-specific overlapping mounts", async () => {
    const roRoot = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [{ path: "/", readonly: true }],
    });
    expect(await roRoot.readFile("/users/u2/chats/2026-06-15.md")).toBe(
      "secret u2\n",
    );
    await expect(
      roRoot.writeFile("/users/u1/preferences/blocked.txt", "x"),
    ).rejects.toMatchObject({ code: "EACCES" });

    const readonlyChild = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [
        { path: "/users" },
        { path: "/users/u1", readonly: true },
      ],
    });
    await expect(
      readonlyChild.writeFile("/users/u1/chats/blocked.txt", "x"),
    ).rejects.toMatchObject({ code: "EACCES" });
    await readonlyChild.writeFile("/users/u2/chats/allowed.txt", "ok\n");
    expect(await root.readFile("/users/u2/chats/allowed.txt")).toBe("ok\n");

    const writableChild = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [
        { path: "/", readonly: true },
        { path: "/users/u1" },
      ],
    });
    await writableChild.writeFile("/users/u1/preferences/allowed.txt", "ok\n");
    await expect(
      writableChild.writeFile("/clienti/acme/blocked.txt", "x"),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("blocks sideways escapes via ..", async () => {
    await expect(
      fs.readFile("/clienti/acme/../globex/data.md"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile("/users/u1/../u2/chats/2026-06-15.md"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves within a mount and across mounts natively (one workspace)", async () => {
    // Within a mount.
    await fs.mv("/users/u1/chats/2026-06-15.md", "/users/u1/chats/renamed.md");
    expect(await fs.readFile("/users/u1/chats/renamed.md")).toBe("hello from u1\n");
    expect(await fs.exists("/users/u1/chats/2026-06-15.md")).toBe(false);

    // Across mounts — no EXDEV, it's the same workspace.
    await fs.mv("/users/u1/chats/renamed.md", "/clienti/acme/imported.md");
    expect(await fs.readFile("/clienti/acme/imported.md")).toBe("hello from u1\n");
    expect(await root.readFile("/clienti/acme/imported.md")).toBe("hello from u1\n");
    expect(await root.exists("/users/u1/chats/renamed.md")).toBe(false);
  });

  it("copies a directory tree across mounts with recursive", async () => {
    await fs.cp("/users/u1/chats", "/clienti/acme/chats-backup", {
      recursive: true,
    });
    expect(await fs.readFile("/clienti/acme/chats-backup/2026-06-15.md")).toBe(
      "hello from u1\n",
    );
  });

  it("copies only mounted descendants when the source is an ancestor", async () => {
    await fs.cp("/clienti", "/users/u1/clienti-copy", { recursive: true });
    expect(await fs.readFile("/users/u1/clienti-copy/acme/report.md")).toBe(
      "acme report\n",
    );
    expect(await root.exists("/users/u1/clienti-copy/globex/data.md")).toBe(false);
  });

  it("supports symlink + readlink within a mount", async () => {
    await fs.writeFile("/users/u1/real.txt", "target content\n");
    await fs.symlink("real.txt", "/users/u1/link.txt");
    expect(await fs.readlink("/users/u1/link.txt")).toBe("real.txt");
    expect(await fs.readFile("/users/u1/link.txt")).toBe("target content\n");
  });

  it("rejects a symlink pointing outside the mount boundary", async () => {
    await expect(
      fs.symlink("/clienti/globex/data.md", "/users/u1/escape.txt"),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("scopes glob to mounted subtrees", async () => {
    const md = await fs.glob("**/*.md", { cwd: "/" });
    expect(md.sort()).toEqual([
      "/clienti/acme/report.md",
      "/general/policy.md",
      "/users/u1/chats/2026-06-15.md",
    ]);
  });

  it("scopes walk to mounted subtrees", async () => {
    const paths = (await fs.walk("/")).map((e) => e.path).sort();
    expect(paths).not.toContain("/users/u2");
    expect(paths).not.toContain("/clienti/globex");
    expect(paths).toContain("/users/u1/chats/2026-06-15.md");
    expect(paths).toContain("/general/policy.md");
    expect(paths).toContain("/clienti/acme/report.md");
  });

  it("scopes diff, history, versionDiff, and usage to mounted subtrees", async () => {
    const b = await root.fork("b");
    await b.writeFile("/users/u2/chats/hidden-b.md", "hidden\n");
    await b.writeFile("/clienti/acme/visible-b.md", "visible\n");

    const diffPaths = (await fs.diff("b")).map((d) => d.path).sort();
    expect(diffPaths).toEqual(["/clienti/acme/visible-b.md"]);
    expect(await fs.diffCount("b")).toBe(1);

    const streamed: string[] = [];
    for await (const entry of fs.diffStream("b", { batchSize: 1 })) {
      streamed.push(entry.path);
    }
    expect(streamed).toEqual(["/clienti/acme/visible-b.md"]);

    const bView = viewForU1(client, ["acme"], "b");
    const history = await bView.listHistory({ includeChanges: true });
    const bEntry = history.entries.find((entry) => entry.version === "b");
    expect(bEntry).toBeDefined();
    expect(bEntry!.changes.map((change) => change.path).sort()).toEqual([
      "/clienti/acme/visible-b.md",
    ]);
    expect((await bView.versionDiff(bEntry!.versionId)).map((d) => d.path)).toEqual([
      "/clienti/acme/visible-b.md",
    ]);

    const versionStreamed: string[] = [];
    for await (const entry of bView.versionDiffStream(bEntry!.versionId, {
      batchSize: 1,
    })) {
      versionStreamed.push(entry.path);
    }
    expect(versionStreamed).toEqual(["/clienti/acme/visible-b.md"]);

    const usage = await bView.getUsage();
    expect(usage.visibleFiles).toBe(5);
  });

  it("scopes merge, cherryPick, and revert writes to mounted subtrees", async () => {
    const mergeSource = await root.fork("merge-source");
    await mergeSource.writeFile("/users/u2/chats/merge-hidden.md", "hidden\n");
    await mergeSource.writeFile("/clienti/acme/merge-visible.md", "visible\n");
    await fs.merge("merge-source");
    expect(await root.readFile("/clienti/acme/merge-visible.md")).toBe("visible\n");
    expect(await root.exists("/users/u2/chats/merge-hidden.md")).toBe(false);

    const cherrySource = await root.fork("cherry-source");
    await cherrySource.writeFile("/users/u2/chats/cherry-hidden.md", "hidden\n");
    await cherrySource.writeFile("/clienti/acme/cherry-visible.md", "visible\n");
    await fs.cherryPick("cherry-source", ["/"]);
    expect(await root.readFile("/clienti/acme/cherry-visible.md")).toBe("visible\n");
    expect(await root.exists("/users/u2/chats/cherry-hidden.md")).toBe(false);

    const work = await root.fork("work");
    await work.writeFile("/users/u2/chats/revert-hidden.md", "hidden\n");
    await work.writeFile("/clienti/acme/revert-visible.md", "visible\n");
    const workView = viewForU1(client, ["acme"], "work");
    await workView.revert(root.version);
    expect(await work.exists("/users/u2/chats/revert-hidden.md")).toBe(true);
    expect(await work.exists("/clienti/acme/revert-visible.md")).toBe(false);
  });

  // Note: textSearch/semanticSearch mount scoping is covered in
  // text-search.test.ts and chunk-search.test.ts, which layer the FTS setup
  // on top of the FTS-off global setup.

  it("respects an expanded set of allowed clients", async () => {
    const wide = viewForU1(client, ["acme", "globex"]);
    expect(await wide.readFile("/clienti/globex/data.md")).toBe("globex data\n");
    expect((await wide.readdir("/clienti")).sort()).toEqual(["acme", "globex"]);
  });

  it("leaves an unmounted instance unrestricted (regression)", async () => {
    expect(await root.readFile("/users/u2/chats/2026-06-15.md")).toBe("secret u2\n");
    expect((await root.readdir("/clienti")).sort()).toEqual(["acme", "globex"]);
  });

  it("drives a real Bash session across mounted subtrees", async () => {
    const bash = new Bash({ fs });

    const cat = await bash.exec("cat /users/u1/chats/2026-06-15.md");
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout).toBe("hello from u1\n");

    const ls = await bash.exec("ls /");
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout.split("\n").filter(Boolean).sort()).toEqual([
      "clienti",
      "general",
      "users",
    ]);

    const write = await bash.exec(
      "echo note > /users/u1/notes.md && cat /users/u1/notes.md",
    );
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toBe("note\n");

    // Read-only mount blocks writes even through the shell; either a throw or a
    // non-zero exit is acceptable, but the content must be untouched.
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

describe("mount SQL helpers", () => {
  it("includes the mount predicate in hybridSearch", async () => {
    let capturedText = "";
    let capturedParams: SqlParam[] = [];
    const fake: SqlClient = {
      query: async <T>(text: string, params: SqlParam[] = []) => {
        capturedText = text;
        capturedParams = params;
        return { rows: [] as T[], rowCount: 0 };
      },
      transaction: async <T>(fn: (client: SqlClient) => Promise<T>) => fn(fake),
    };

    await hybridSearch(fake, WS, 1, "policy", [0.1], {
      mounts: compileMounts([{ path: "/clienti/acme" }], "/", WS),
    });

    expect(capturedText).toContain("AND (e.path <@ ANY");
    const mountParam = capturedParams.find(
      (param): param is string[] =>
        Array.isArray(param) && param.every((value) => typeof value === "string"),
    );
    expect(mountParam?.some((ltree) => ltree.endsWith(".clienti.acme"))).toBe(true);
  });
});
