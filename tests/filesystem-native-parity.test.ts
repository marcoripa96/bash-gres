import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  chmod as nodeChmod,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  readlink as nodeReadlink,
  realpath as nodeRealpath,
  rm as nodeRm,
  stat as nodeStat,
  symlink as nodeSymlink,
  utimes as nodeUtimes,
  writeFile as nodeWriteFile,
  mkdtemp,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEST_ADAPTERS } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../src/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

describe.each(TEST_ADAPTERS)("PgFileSystem: native parity [%s]", (_name, factory) => {
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
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [
      "test-workspace-native-parity",
    ]);
    fs = new PgFileSystem({ db: client, workspaceId: "test-workspace-native-parity" });
    await fs.init();
  });

  it("preserves relative symlink targets like the native filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-fs-link-"));

    try {
      await nodeMkdir(join(root, "dir"));
      await nodeMkdir(join(root, "links"));
      await nodeWriteFile(join(root, "dir", "target.txt"), "content");
      await nodeSymlink("../dir/target.txt", join(root, "links", "link.txt"));

      await fs.mkdir("/dir", { recursive: true });
      await fs.mkdir("/links", { recursive: true });
      await fs.writeFile("/dir/target.txt", "content");
      await fs.symlink("../dir/target.txt", "/links/link.txt");

      expect(await fs.readlink("/links/link.txt")).toBe(
        await nodeReadlink(join(root, "links", "link.txt")),
      );
      expect(await fs.readFile("/links/link.txt")).toBe(
        await nodeReadFile(join(root, "links", "link.txt"), "utf8"),
      );
      expect(await fs.realpath("/links/link.txt")).toBe(
        (await nodeRealpath(join(root, "links", "link.txt"))).replace(root, ""),
      );
    } finally {
      await nodeRm(root, { recursive: true, force: true });
    }
  });

  it("readdir follows symlinks to directories like the native filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-fs-readdir-"));

    try {
      await nodeMkdir(join(root, "real"));
      await nodeWriteFile(join(root, "real", "file.txt"), "content");
      await nodeSymlink("real", join(root, "alias"));

      await fs.mkdir("/real", { recursive: true });
      await fs.writeFile("/real/file.txt", "content");
      await fs.symlink("real", "/alias");

      expect(await fs.readdir("/alias")).toEqual(
        await nodeReaddir(join(root, "alias")),
      );
    } finally {
      await nodeRm(root, { recursive: true, force: true });
    }
  });

  it("chmod follows symlinks like the native filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-fs-chmod-"));

    try {
      await nodeWriteFile(join(root, "target.txt"), "content");
      await nodeSymlink("target.txt", join(root, "link.txt"));
      await nodeChmod(join(root, "link.txt"), 0o600);

      await fs.writeFile("/target.txt", "content");
      await fs.symlink("target.txt", "/link.txt");
      await fs.chmod("/link.txt", 0o600);

      expect((await fs.stat("/target.txt")).mode).toBe(
        (await nodeStat(join(root, "target.txt"))).mode & 0o777,
      );
      expect((await fs.lstat("/link.txt")).mode).toBe(
        (await nodeLstat(join(root, "link.txt"))).mode & 0o777,
      );
    } finally {
      await nodeRm(root, { recursive: true, force: true });
    }
  });

  it("utimes follows symlinks like the native filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-gres-native-fs-utimes-"));

    try {
      const targetTime = new Date("2024-01-01T00:00:00.000Z");
      await nodeWriteFile(join(root, "target.txt"), "content");
      await nodeSymlink("target.txt", join(root, "link.txt"));
      const realLinkBefore = await nodeLstat(join(root, "link.txt"));
      await nodeUtimes(join(root, "link.txt"), targetTime, targetTime);

      await fs.writeFile("/target.txt", "content");
      await fs.symlink("target.txt", "/link.txt");
      const virtualLinkBefore = await fs.lstat("/link.txt");
      await fs.utimes("/link.txt", targetTime, targetTime);

      expect((await fs.stat("/target.txt")).mtime.getTime()).toBe(
        (await nodeStat(join(root, "target.txt"))).mtime.getTime(),
      );
      expect((await fs.lstat("/link.txt")).mtime.getTime()).toBe(
        virtualLinkBefore.mtime.getTime(),
      );
      expect((await nodeLstat(join(root, "link.txt"))).mtime.getTime()).toBe(
        realLinkBefore.mtime.getTime(),
      );
    } finally {
      await nodeRm(root, { recursive: true, force: true });
    }
  });
});
