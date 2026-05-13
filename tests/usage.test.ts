import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { FsQuotaError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

describe.each(TEST_ADAPTERS)("workspace usage [%s]", (_name, factory) => {
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
    await resetWorkspace(client, "usage-workspace");
    fs = new PgFileSystem({ db: client, workspaceId: "usage-workspace" });
    await fs.init();
  });

  it("reports initial workspace usage", async () => {
    const usage = await fs.getUsage();

    expect(usage).toMatchObject({
      workspaceId: "usage-workspace",
      version: "main",
      path: "/",
      logicalBytes: 0,
      referencedBlobBytes: 0,
      storedBlobBytes: 0,
      blobCount: 0,
      versions: 1,
      entryRows: 1,
      tombstoneRows: 0,
      visibleNodes: 1,
      visibleFiles: 0,
      visibleDirectories: 1,
      visibleSymlinks: 0,
    });
    expect(usage.limits.maxFiles).toBeGreaterThan(0);
    expect(usage.limits.maxFileSize).toBeGreaterThan(0);
  });

  it("separates logical bytes from deduplicated stored blob bytes", async () => {
    await fs.writeFile("/a.txt", "hello");
    await fs.writeFile("/b.txt", "hello");
    await fs.symlink("/a.txt", "/link");

    const usage = await fs.getUsage();

    expect(usage.logicalBytes).toBe(16);
    expect(usage.referencedBlobBytes).toBe(5);
    expect(usage.storedBlobBytes).toBe(5);
    expect(usage.blobCount).toBe(1);
    expect(usage.visibleNodes).toBe(4);
    expect(usage.visibleFiles).toBe(2);
    expect(usage.visibleDirectories).toBe(1);
    expect(usage.visibleSymlinks).toBe(1);
    expect(usage.entryRows).toBe(4);
  });

  it("counts copy-on-write versions without double-counting inherited blobs", async () => {
    await fs.writeFile("/a.txt", "hello");
    await fs.writeFile("/b.txt", "hello");

    const child = await fs.fork("draft");
    await child.writeFile("/a.txt", "new");
    await child.rm("/b.txt");

    const mainUsage = await fs.getUsage();
    const childUsage = await child.getUsage();

    expect(mainUsage.logicalBytes).toBe(10);
    expect(mainUsage.visibleFiles).toBe(2);
    expect(mainUsage.visibleNodes).toBe(3);

    expect(childUsage.version).toBe("draft");
    expect(childUsage.logicalBytes).toBe(3);
    expect(childUsage.referencedBlobBytes).toBe(3);
    expect(childUsage.visibleFiles).toBe(1);
    expect(childUsage.visibleNodes).toBe(2);

    expect(childUsage.versions).toBe(2);
    expect(childUsage.entryRows).toBe(5);
    expect(childUsage.tombstoneRows).toBe(1);
    expect(childUsage.blobCount).toBe(2);
    expect(childUsage.storedBlobBytes).toBe(8);
  });

  it("scopes visible usage to a path", async () => {
    await fs.writeFile("/project/a.txt", "aaaa");
    await fs.writeFile("/project/nested/b.txt", "bb");
    await fs.writeFile("/other.txt", "outside");
    await fs.writeFile("/project/copy.txt", "aaaa");
    await fs.symlink("/project/a.txt", "/project/link");

    const usage = await fs.getUsage({ path: "/project" });

    expect(usage.path).toBe("/project");
    expect(usage.logicalBytes).toBe(24);
    expect(usage.referencedBlobBytes).toBe(6);
    expect(usage.storedBlobBytes).toBe(13);
    expect(usage.visibleNodes).toBe(6);
    expect(usage.visibleFiles).toBe(3);
    expect(usage.visibleDirectories).toBe(2);
    expect(usage.visibleSymlinks).toBe(1);
  });

  it("reports deduplicated blob usage across all versions of a versioned directory", async () => {
    await fs.mkdir("/db", { versioned: true });
    const dbMain = await fs.versioned("/db");

    await dbMain.writeFile("/a.txt", "aaaa"); // 4 bytes
    await dbMain.writeFile("/b.txt", "bbbb"); // 4 bytes

    const dbDraft = await dbMain.fork("draft");
    await dbDraft.writeFile("/a.txt", "AAAAAA"); // 6 bytes — replaces a.txt in draft only

    const dbStale = await dbMain.fork("stale");
    await dbStale.rm("/b.txt"); // tombstones b.txt in stale; doesn't drop the blob

    const mainUsage = await dbMain.getUsage({ includeAcrossVersions: true });
    const draftUsage = await dbDraft.getUsage({ includeAcrossVersions: true });

    expect(mainUsage.acrossVersions).toBeDefined();
    expect(mainUsage.acrossVersions).toEqual(draftUsage.acrossVersions);

    // Distinct blobs referenced by *any* version inside /db: aaaa, bbbb, AAAAAA.
    expect(mainUsage.acrossVersions!.referencedBlobCount).toBe(3);
    expect(mainUsage.acrossVersions!.referencedBlobBytes).toBe(14);

    // Per-version values shouldn't equal the across-versions value — summing
    // them would over-count (main 8 + draft 10 + stale 4 = 22 > 14).
    expect(mainUsage.referencedBlobBytes).toBe(8);
    expect(draftUsage.referencedBlobBytes).toBe(10);
  });

  it("omits acrossVersions when includeAcrossVersions is not set", async () => {
    await fs.mkdir("/db", { versioned: true });
    const dbMain = await fs.versioned("/db");
    await dbMain.writeFile("/a.txt", "x");

    const usage = await dbMain.getUsage();
    expect(usage.acrossVersions).toBeUndefined();
  });

  it("scopes acrossVersions by path inside a versioned directory", async () => {
    await fs.mkdir("/db", { versioned: true });
    const dbMain = await fs.versioned("/db");
    await dbMain.writeFile("/keep/k.txt", "kk"); // 2 bytes
    await dbMain.writeFile("/drop/d.txt", "ddd"); // 3 bytes
    await dbMain.fork("draft");

    const scoped = await dbMain.getUsage({
      path: "/keep",
      includeAcrossVersions: true,
    });

    expect(scoped.acrossVersions!.referencedBlobCount).toBe(1);
    expect(scoped.acrossVersions!.referencedBlobBytes).toBe(2);
  });

  it("enforces maxWorkspaceBytes with structured ENOSPC errors", async () => {
    const limited = new PgFileSystem({
      db: client,
      workspaceId: "usage-workspace",
      maxWorkspaceBytes: 5,
    });
    await limited.init();
    await limited.writeFile("/a.txt", "hello");

    let error: unknown;
    try {
      await limited.writeFile("/b.txt", "world!");
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(FsQuotaError);
    expect(error).toMatchObject({
      code: "ENOSPC",
      limit: 5,
      current: 5,
      attemptedDelta: 6,
    });
    await expect(limited.exists("/b.txt")).resolves.toBe(false);
  });

  it("does not charge quota again for an existing blob hash", async () => {
    const limited = new PgFileSystem({
      db: client,
      workspaceId: "usage-workspace",
      maxWorkspaceBytes: 5,
    });
    await limited.init();

    await limited.writeFile("/a.txt", "hello");
    await limited.writeFile("/b.txt", "hello");

    const usage = await limited.getUsage();
    expect(usage.storedBlobBytes).toBe(5);
    expect(usage.logicalBytes).toBe(10);
    expect(usage.limits.maxWorkspaceBytes).toBe(5);
  });

  it("enforces maxFiles strictly at the boundary", async () => {
    // Tests the optimistic node-count cache: writes succeed up to the limit,
    // and the next write fails. Exercises both the warm cache path (most
    // writes skip COUNT) and the boundary fallback (the last few writes
    // re-query the actual count).
    const MAX = 20;
    const limited = new PgFileSystem({
      db: client,
      workspaceId: "usage-workspace",
      maxFiles: MAX,
    });
    await limited.init();

    // The root directory entry counts as 1 toward the limit, so we can
    // write MAX-1 files before refusing.
    for (let i = 0; i < MAX - 1; i++) {
      await limited.writeFile(`/f${i}.txt`, "x");
    }

    await expect(limited.writeFile(`/over.txt`, "y")).rejects.toThrow(
      /Node limit reached/,
    );
    await expect(limited.exists(`/over.txt`)).resolves.toBe(false);

    // After a refusal, removing a file should free a slot for the next
    // write — confirms the cache doesn't permanently lock writes out.
    await limited.rm(`/f0.txt`);
    await limited.writeFile(`/recovered.txt`, "z");
    await expect(limited.exists(`/recovered.txt`)).resolves.toBe(true);
  });

  it("recovers from cache drift after delete bursts", async () => {
    // The cached node count never decrements, so after a large delete burst
    // it overestimates the actual count. This test exercises that drift:
    // we fill near `maxFiles`, empty the workspace, then refill — and
    // confirm we can still use every available slot, that the next write
    // past the limit still fails, and that the cache catches up to reality.
    const MAX = 30;
    const limited = new PgFileSystem({
      db: client,
      workspaceId: "usage-workspace",
      maxFiles: MAX,
    });
    await limited.init();

    // Phase 1: fill exactly to the limit (root + MAX-1 files). Cache
    // reaches MAX.
    for (let i = 0; i < MAX - 1; i++) {
      await limited.writeFile(`/phase1-${i}.txt`, "x");
    }

    // Empty the workspace. Actual count drops back to 1, but the cache
    // stays inflated because we deliberately don't decrement on rm.
    for (let i = 0; i < MAX - 1; i++) {
      await limited.rm(`/phase1-${i}.txt`);
    }

    // Phase 2: refill to the limit. The first write triggers a fallback
    // `COUNT(*)` because the inflated cache is inside HEADROOM of MAX, so
    // it re-syncs to reality. Every slot up to MAX should be writable.
    for (let i = 0; i < MAX - 1; i++) {
      await limited.writeFile(`/phase2-${i}.txt`, "x");
    }

    // One past the limit should still be refused.
    await expect(limited.writeFile(`/over.txt`, "y")).rejects.toThrow(
      /Node limit reached/,
    );
    await expect(limited.exists(`/over.txt`)).resolves.toBe(false);
  });

  it("requires the current version to exist", async () => {
    const missing = new PgFileSystem({
      db: client,
      workspaceId: "usage-workspace",
      version: "missing",
    });

    await expect(missing.getUsage()).rejects.toThrow(/does not exist/);
  });
});
