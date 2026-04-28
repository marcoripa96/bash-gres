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

  it("requires the current version to exist", async () => {
    const missing = new PgFileSystem({
      db: client,
      workspaceId: "usage-workspace",
      version: "missing",
    });

    await expect(missing.getUsage()).rejects.toThrow(/does not exist/);
  });
});
