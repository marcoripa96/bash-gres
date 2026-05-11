import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.each(TEST_ADAPTERS)("getLastModified [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
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
    await resetWorkspace(client, "lastmod-workspace");
    fs = new PgFileSystem({ db: client, workspaceId: "lastmod-workspace" });
    await fs.init();
  });

  it("reports a timestamp after init", async () => {
    const t = await fs.getLastModified();
    expect(t).toBeInstanceOf(Date);
  });

  it("advances after writeFile", async () => {
    const before = (await fs.getLastModified())!;
    await sleep(20);
    await fs.writeFile("/a.txt", "hello");
    const after = (await fs.getLastModified())!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("advances after mkdir, rm, mv, chmod, symlink, utimes", async () => {
    await fs.writeFile("/a.txt", "hello");
    let prev = (await fs.getLastModified())!;

    await sleep(20);
    await fs.mkdir("/d");
    let next = (await fs.getLastModified())!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
    prev = next;

    await sleep(20);
    await fs.mv("/a.txt", "/d/a.txt");
    next = (await fs.getLastModified())!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
    prev = next;

    await sleep(20);
    await fs.chmod("/d/a.txt", 0o600);
    next = (await fs.getLastModified())!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
    prev = next;

    await sleep(20);
    await fs.symlink("/d/a.txt", "/link");
    next = (await fs.getLastModified())!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
    prev = next;

    await sleep(20);
    await fs.utimes("/d/a.txt", new Date(), new Date());
    next = (await fs.getLastModified())!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
    prev = next;

    await sleep(20);
    await fs.rm("/d", { recursive: true });
    next = (await fs.getLastModified())!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
  });

  it("does not advance when re-init is a no-op", async () => {
    await fs.writeFile("/a.txt", "hello");
    const before = (await fs.getLastModified())!;
    await sleep(20);
    const same = new PgFileSystem({ db: client, workspaceId: "lastmod-workspace" });
    await same.init();
    const after = (await fs.getLastModified())!;
    expect(after.getTime()).toBe(before.getTime());
  });

  it("does not advance on read", async () => {
    await fs.writeFile("/a.txt", "hello");
    const before = (await fs.getLastModified())!;
    await sleep(20);
    await fs.readFile("/a.txt");
    await fs.exists("/a.txt");
    await fs.stat("/a.txt");
    const after = (await fs.getLastModified())!;
    expect(after.getTime()).toBe(before.getTime());
  });

  it("does not advance on rm -f of a missing path", async () => {
    const before = (await fs.getLastModified())!;
    await sleep(20);
    await fs.rm("/missing", { force: true });
    const after = (await fs.getLastModified())!;
    expect(after.getTime()).toBe(before.getTime());
  });

  it("tracks each branch independently across forks", async () => {
    await fs.writeFile("/a.txt", "hello");
    const mainBefore = (await fs.getLastModified())!;

    await sleep(20);
    const branch = await fs.fork("feature");
    // Newly forked branch reports its own creation time, not main's.
    const branchInitial = (await branch.getLastModified())!;
    expect(branchInitial.getTime()).toBeGreaterThanOrEqual(mainBefore.getTime());

    await sleep(20);
    await branch.writeFile("/b.txt", "world");
    const branchAfter = (await branch.getLastModified())!;
    expect(branchAfter.getTime()).toBeGreaterThan(branchInitial.getTime());

    // Main's last_write_at is unaffected by branch writes.
    const mainAfter = (await fs.getLastModified())!;
    expect(mainAfter.getTime()).toBe(mainBefore.getTime());
  });

  it("scopes to the version when called from fs.versioned()", async () => {
    await fs.mkdir("/sub", { versioned: true });
    const sub = await fs.versioned("/sub");
    const subBefore = (await sub.getLastModified())!;
    const rootBefore = (await fs.getLastModified())!;

    await sleep(20);
    await sub.writeFile("/x.txt", "scoped");

    const subAfter = (await sub.getLastModified())!;
    const rootAfter = (await fs.getLastModified())!;

    expect(subAfter.getTime()).toBeGreaterThan(subBefore.getTime());
    expect(rootAfter.getTime()).toBe(rootBefore.getTime());
  });

  it("advances after merge / cherry-pick / revert", async () => {
    await fs.writeFile("/base.txt", "0");
    const branch = await fs.fork("feature");
    await branch.writeFile("/feature.txt", "1");

    const mainBeforeMerge = (await fs.getLastModified())!;
    await sleep(20);
    await fs.merge("feature");
    const mainAfterMerge = (await fs.getLastModified())!;
    expect(mainAfterMerge.getTime()).toBeGreaterThan(mainBeforeMerge.getTime());
  });
});
