import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { FsError } from "../lib/core/types.js";
import { ensureSetup } from "./global-setup.js";
import { resetWorkspace, TEST_ADAPTERS, type SqlClient } from "./helpers.js";

const WS = "version-id-test";
const OTHER_WS = "version-id-test-other";

describe.each(TEST_ADAPTERS)("versionId snapshots [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
  });

  afterAll(async () => {
    await teardown?.();
  });

  beforeEach(async () => {
    await resetWorkspace(client, WS);
    await resetWorkspace(client, OTHER_WS);
  });

  it("opens a retained version after its label is deleted", async () => {
    const main = new PgFileSystem({
      db: client,
      workspaceId: WS,
      historyRetention: "retain",
    });
    await main.init();
    await main.writeFile("/knowledge.md", "v1");
    const v1 = (await main.listHistory({ limit: 1 })).entries[0]!.versionId;

    const next = await main.fork("next");
    await next.writeFile("/knowledge.md", "v2");
    await next.promoteTo("main", { dropPrevious: true });

    const snapshot = new PgFileSystem({
      db: client,
      workspaceId: WS,
      versionId: v1,
      permissions: { read: true, write: false },
    });
    expect(await snapshot.readFile("/knowledge.md")).toBe("v1");
    await expect(snapshot.writeFile("/knowledge.md", "changed")).rejects.toMatchObject({
      code: "EPERM",
    } satisfies Partial<FsError>);
    expect(await next.readFile("/knowledge.md")).toBe("v2");
  });

  it("keeps a conversation on one snapshot across later promotions", async () => {
    const main = new PgFileSystem({
      db: client,
      workspaceId: WS,
      historyRetention: "retain",
    });
    await main.init();
    await main.mkdir("/general", { recursive: true });
    await main.mkdir("/clienti/123", { recursive: true });
    await main.mkdir("/users/seller/preferences", { recursive: true });
    await main.writeFile("/general/context.md", "general-v1");
    await main.writeFile("/clienti/123/note.md", "client-v1");
    await main.writeFile("/users/seller/preferences/tone.md", "tone-v1");
    const conversationVersion = (await main.listHistory({ limit: 1 })).entries[0]!
      .versionId;

    const v2 = await main.fork("v2");
    await v2.writeFile("/general/context.md", "general-v2");
    await v2.writeFile("/clienti/123/note.md", "client-v2");
    await v2.writeFile("/users/seller/preferences/tone.md", "tone-v2");
    await v2.promoteTo("main", { dropPrevious: true });

    const v3 = await v2.fork("v3");
    await v3.writeFile("/general/context.md", "general-v3");
    await v3.writeFile("/clienti/123/note.md", "client-v3");
    await v3.writeFile("/users/seller/preferences/tone.md", "tone-v3");
    await v3.promoteTo("main", { dropPrevious: true });

    const preferences = new PgFileSystem({
      db: client,
      workspaceId: WS,
      versionId: conversationVersion,
      permissions: { read: true, write: false },
    });
    const tools = new PgFileSystem({
      db: client,
      workspaceId: WS,
      versionId: conversationVersion,
      permissions: { read: true, write: false },
      mount: [
        { path: "/general", readonly: true },
        { path: "/clienti/123", readonly: true },
      ],
    });
    expect(await preferences.readFile("/users/seller/preferences/tone.md")).toBe(
      "tone-v1",
    );
    expect(await tools.readFile("/general/context.md")).toBe("general-v1");
    expect(await tools.readFile("/clienti/123/note.md")).toBe("client-v1");
    await expect(
      tools.readFile("/users/seller/preferences/tone.md"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const current = new PgFileSystem({
      db: client,
      workspaceId: WS,
      permissions: { read: true, write: false },
    });
    expect(await current.readFile("/general/context.md")).toBe("general-v3");
    const currentVersion = (await current.listHistory({ limit: 1 })).entries[0]!
      .versionId;
    expect(currentVersion).not.toBe(conversationVersion);

    const history = (await v3.listHistory()).entries;
    expect(history.find((entry) => entry.versionId === conversationVersion)?.deletedAt)
      .toBeInstanceOf(Date);
    await expect(tools.writeFile("/general/context.md", "changed")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("rejects an id from another workspace", async () => {
    const other = new PgFileSystem({ db: client, workspaceId: OTHER_WS });
    await other.init();
    const otherId = (await other.listHistory({ limit: 1 })).entries[0]!.versionId;

    const snapshot = new PgFileSystem({
      db: client,
      workspaceId: WS,
      versionId: otherId,
      permissions: { write: false },
    });
    await expect(snapshot.readdir("/")).rejects.toThrow(
      `Version id '${otherId}' does not exist`,
    );
  });

  it("rejects an id from another version root", async () => {
    const root = new PgFileSystem({ db: client, workspaceId: WS });
    await root.init();
    await root.mkdir("/nested", { versioned: true });
    const nested = await root.versioned("/nested");
    const nestedId = (await nested.listHistory({ limit: 1 })).entries[0]!.versionId;

    const snapshot = new PgFileSystem({
      db: client,
      workspaceId: WS,
      versionId: nestedId,
      permissions: { write: false },
    });
    await expect(snapshot.readdir("/")).rejects.toThrow(
      `Version id '${nestedId}' does not exist`,
    );
  });

  it("validates constructor options", () => {
    expect(
      () =>
        new PgFileSystem({
          db: client,
          version: "main",
          versionId: 1,
          permissions: { write: false },
        }),
    ).toThrow("version and versionId are mutually exclusive");
    expect(() => new PgFileSystem({ db: client, versionId: 0 })).toThrow(
      "versionId must be a positive safe integer",
    );
    expect(() => new PgFileSystem({ db: client, versionId: 1 })).toThrow(
      "versionId requires permissions.write to be false",
    );
  });
});
