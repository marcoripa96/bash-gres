import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { ensureSetup } from "./global-setup.js";
import { resetWorkspace, TEST_ADAPTERS, type SqlClient } from "./helpers.js";

const WS = "diff-versions-test";

describe.each(TEST_ADAPTERS)("diffVersions [%s]", (_name, factory) => {
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
  });

  /** Build a three-version chain of retained, label-less versions — the shape
   *  a promote-onto-main history leaves behind — and return their ids. */
  async function seedChain(): Promise<{
    fs: PgFileSystem;
    a: number;
    b: number;
    c: number;
  }> {
    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS,
      historyRetention: "retain",
    });
    await fs.init();
    await fs.mkdir("/clienti/c1", { recursive: true });
    await fs.mkdir("/general", { recursive: true });
    await fs.writeFile("/clienti/c1/note.md", "v1-note");
    await fs.writeFile("/general/doc.md", "shared");
    const a = (await fs.listHistory({ limit: 1 })).entries[0]!.versionId;

    const r1 = await fs.fork("r1");
    await r1.writeFile("/clienti/c1/note.md", "v2-note");
    await r1.writeFile("/clienti/c1/extra.md", "extra");
    await r1.promoteTo("main", { dropPrevious: true });
    const b = (await r1.listHistory({ limit: 1 })).entries[0]!.versionId;

    const r2 = await r1.fork("r2");
    await r2.rm("/clienti/c1/extra.md");
    await r2.writeFile("/general/doc.md", "shared-2");
    await r2.promoteTo("main", { dropPrevious: true });
    const c = (await r2.listHistory({ limit: 1 })).entries[0]!.versionId;

    return { fs, a, b, c };
  }

  it("diffs two retained label-less versions, adjacent or not", async () => {
    const { fs, a, b, c } = await seedChain();

    const adjacent = await fs.diffVersions(a, b, { includeContent: true });
    expect(adjacent.map((e) => [e.path, e.change]).sort()).toEqual([
      ["/clienti/c1/extra.md", "added"],
      ["/clienti/c1/note.md", "modified"],
    ]);
    const note = adjacent.find((e) => e.path === "/clienti/c1/note.md")!;
    expect(note.beforeContent).toBe("v1-note");
    expect(note.afterContent).toBe("v2-note");
    const extra = adjacent.find((e) => e.path === "/clienti/c1/extra.md")!;
    expect(extra.before).toBeNull();
    expect(extra.afterContent).toBe("extra");

    // Skipping the middle version: extra.md was added then removed between the
    // endpoints, so it exists on neither side and never appears — the pair is
    // compared tree-to-tree, not by replaying intermediate steps.
    const span = await fs.diffVersions(a, c);
    expect(span.map((e) => [e.path, e.change]).sort()).toEqual([
      ["/clienti/c1/note.md", "modified"],
      ["/general/doc.md", "modified"],
    ]);

    const backward = await fs.diffVersions(b, a, { includeContent: true });
    const noteBack = backward.find((e) => e.path === "/clienti/c1/note.md")!;
    expect(noteBack.beforeContent).toBe("v2-note");
    expect(noteBack.afterContent).toBe("v1-note");
    expect(
      backward.find((e) => e.path === "/clienti/c1/extra.md")!.change,
    ).toBe("removed");
  });

  it("returns an empty diff for the same version", async () => {
    const { fs, a } = await seedChain();
    expect(await fs.diffVersions(a, a)).toEqual([]);
  });

  it("scopes the comparison to a subtree", async () => {
    const { fs, a, c } = await seedChain();
    const scoped = await fs.diffVersions(a, c, { path: "/general" });
    expect(scoped.map((e) => e.path)).toEqual(["/general/doc.md"]);
  });

  it("rejects ids that are not versions of this root", async () => {
    const { fs, a } = await seedChain();
    await expect(fs.diffVersions(a, a + 999)).rejects.toThrow(
      `diffVersions: version id ${a + 999} not found in this version root`,
    );

    await fs.mkdir("/nested", { versioned: true });
    const nested = await fs.versioned("/nested");
    const nestedId = (await nested.listHistory({ limit: 1 })).entries[0]!
      .versionId;
    await expect(fs.diffVersions(a, nestedId)).rejects.toThrow(
      "not found in this version root",
    );

    await expect(fs.diffVersions(0, a)).rejects.toThrow(
      "diffVersions: from must be a positive integer",
    );
    await expect(fs.diffVersions(a, 1.5)).rejects.toThrow(
      "diffVersions: to must be a positive integer",
    );
  });
});
