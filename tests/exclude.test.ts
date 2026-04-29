import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "test-exclude";

function expectENOENT(promise: Promise<unknown>) {
  return expect(promise).rejects.toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
}

describe.each(TEST_ADAPTERS)("exclude [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let admin: PgFileSystem;

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
    admin = new PgFileSystem({ db: client, workspaceId: WS });
    await admin.init();
    // Seed a tree with a mix of normal and excluded-target paths.
    await admin.mkdir("/src", { recursive: true });
    await admin.mkdir("/src/sub", { recursive: true });
    await admin.mkdir("/build", { recursive: true });
    await admin.mkdir("/.git/hooks", { recursive: true });
    await admin.mkdir("/pkg/node_modules/foo", { recursive: true });
    await admin.writeFile("/src/index.ts", "export {}");
    await admin.writeFile("/src/sub/util.ts", "x");
    await admin.writeFile("/src/error.log", "log");
    await admin.writeFile("/build/out.bin", "bin");
    await admin.writeFile("/.git/HEAD", "ref");
    await admin.writeFile("/.git/hooks/pre-commit", "#!/bin/sh");
    await admin.writeFile("/pkg/node_modules/foo/index.js", "x");
    await admin.writeFile("/README.md", "readme");
  });

  describe("label-name patterns (single segment, no slash)", () => {
    it("hides directory matching the pattern at any depth", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules"],
      });
      expect(await fs.exists("/pkg/node_modules")).toBe(false);
      expect(await fs.exists("/pkg/node_modules/foo")).toBe(false);
      expect(await fs.exists("/pkg/node_modules/foo/index.js")).toBe(false);
      expect(await fs.exists("/pkg")).toBe(true);
    });

    it("readdir omits excluded children", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules"],
      });
      const entries = await fs.readdir("/pkg");
      expect(entries).not.toContain("node_modules");
    });

    it("walk omits excluded subtrees", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules"],
      });
      const all = await fs.walk("/");
      const paths = all.map((e) => e.path);
      expect(paths).not.toContain("/pkg/node_modules");
      expect(paths.some((p) => p.startsWith("/pkg/node_modules"))).toBe(false);
      expect(paths).toContain("/pkg");
    });
  });

  describe("anchored patterns (leading slash)", () => {
    it("hides exact subtree at root", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["/build"],
      });
      expect(await fs.exists("/build")).toBe(false);
      expect(await fs.exists("/build/out.bin")).toBe(false);
      expect(await fs.exists("/src")).toBe(true);
    });

    it("does not hide same name at non-root depth", async () => {
      // /src/build should NOT be hidden by `/build`.
      await admin.mkdir("/src/build");
      await admin.writeFile("/src/build/keep.txt", "keep");
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["/build"],
      });
      expect(await fs.exists("/src/build/keep.txt")).toBe(true);
    });
  });

  describe("dotted-prefix patterns", () => {
    it("hides .git via label-name pattern", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: [".git"],
      });
      expect(await fs.exists("/.git")).toBe(false);
      expect(await fs.exists("/.git/HEAD")).toBe(false);
      expect(await fs.exists("/.git/hooks/pre-commit")).toBe(false);
      expect(await fs.exists("/README.md")).toBe(true);
    });
  });

  describe("intra-label glob patterns", () => {
    it("hides leaf files matching *.log", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
      });
      expect(await fs.exists("/src/error.log")).toBe(false);
      expect(await fs.exists("/src/index.ts")).toBe(true);
    });

    it("matches at any depth", async () => {
      await admin.writeFile("/deep.log", "x");
      await admin.mkdir("/dir/sub", { recursive: true });
      await admin.writeFile("/dir/sub/buried.log", "x");
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
      });
      expect(await fs.exists("/deep.log")).toBe(false);
      expect(await fs.exists("/dir/sub/buried.log")).toBe(false);
    });

    it("readdir omits leaf-glob matches", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
      });
      const entries = await fs.readdir("/src");
      expect(entries).toContain("index.ts");
      expect(entries).not.toContain("error.log");
    });
  });

  describe("multiple patterns", () => {
    it("combines all patterns with OR", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules", "/build", "*.log", ".git"],
      });
      expect(await fs.exists("/pkg/node_modules/foo")).toBe(false);
      expect(await fs.exists("/build")).toBe(false);
      expect(await fs.exists("/src/error.log")).toBe(false);
      expect(await fs.exists("/.git")).toBe(false);
      expect(await fs.exists("/src/index.ts")).toBe(true);
    });
  });

  describe("write-side guards", () => {
    it("writeFile to excluded path throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules"],
      });
      await expectENOENT(fs.writeFile("/pkg/node_modules/new.js", "x"));
    });

    it("mkdir on excluded path throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["/build"],
      });
      await expectENOENT(fs.mkdir("/build/sub"));
    });

    it("rm on excluded path throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["/build"],
      });
      await expectENOENT(fs.rm("/build/out.bin"));
    });

    it("cp dest into excluded throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules"],
      });
      await fs.writeFile("/scratch.js", "x");
      await expectENOENT(fs.cp("/scratch.js", "/pkg/node_modules/copy.js"));
    });

    it("mv from excluded src throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
      });
      await expectENOENT(fs.mv("/src/error.log", "/src/error2.log"));
    });

    it("symlink with excluded link path throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["/build"],
      });
      await expectENOENT(fs.symlink("/src/index.ts", "/build/link"));
    });
  });

  describe("read-side ENOENT", () => {
    it("readFile of excluded path throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
      });
      await expectENOENT(fs.readFile("/src/error.log"));
    });

    it("stat of excluded path throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules"],
      });
      await expectENOENT(fs.stat("/pkg/node_modules"));
    });

    it("readdir of excluded directory throws ENOENT", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["/build"],
      });
      await expectENOENT(fs.readdir("/build"));
    });
  });

  describe("admin instance still sees everything", () => {
    it("a separate instance without exclude reads excluded paths", async () => {
      // The exclusion is per-instance and view-only; storage is unchanged.
      expect(await admin.exists("/pkg/node_modules/foo/index.js")).toBe(true);
      expect(await admin.readFile("/src/error.log")).toBe("log");
    });
  });

  describe("getUsage respects exclude", () => {
    it("does not count excluded entries in visibleNodes", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["node_modules", ".git", "*.log", "/build"],
      });
      const usage = await fs.getUsage();
      const adminUsage = await admin.getUsage();
      expect(usage.visibleNodes).toBeLessThan(adminUsage.visibleNodes);
    });
  });

  describe("glob respects exclude", () => {
    it("excluded patterns do not appear in glob results", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        exclude: ["*.log"],
      });
      const matches = await fs.glob("**/*");
      expect(matches.some((p) => p.endsWith(".log"))).toBe(false);
    });
  });

  describe("rootDir + exclude composition", () => {
    it("exclude patterns apply within rootDir scope", async () => {
      await admin.mkdir("/jail/node_modules", { recursive: true });
      await admin.writeFile("/jail/node_modules/x.js", "x");
      await admin.writeFile("/jail/keep.txt", "k");
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        rootDir: "/jail",
        exclude: ["node_modules"],
      });
      expect(await fs.exists("/keep.txt")).toBe(true);
      expect(await fs.exists("/node_modules")).toBe(false);
    });

    it("anchored exclude is anchored to rootDir, not workspace root", async () => {
      // /jail/build should be excluded; /build (outside jail) is invisible
      // anyway via rootDir.
      await admin.mkdir("/jail/build", { recursive: true });
      await admin.writeFile("/jail/build/out", "x");
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        rootDir: "/jail",
        exclude: ["/build"],
      });
      expect(await fs.exists("/build")).toBe(false);
      expect(await fs.exists("/build/out")).toBe(false);
    });
  });
});
