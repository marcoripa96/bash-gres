import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { SqlError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

const WS = "chunk-search-workspace";

const ABOUT = [
  "---",
  'title: "Widget Co"',
  "---",
  "",
  "We build widgets.",
  "",
  "## Shipping",
  "",
  "Shipping is free over fifty euros. Shipping takes two days.",
  "",
  "## Team",
  "",
  "Two hundred people build widgets here.",
].join("\n");

// A long off-topic section with a single passing mention of shipping — BM25's
// length normalization must rank it below the dedicated section above.
const MISC = [
  "# Company history",
  "",
  "Founded in a garage, the company grew through wholesale partnerships,",
  "trade fairs, catalog sales, regional distribution centers, seasonal",
  "campaigns, loyalty programs, and one small note about shipping crates",
  "used in the early days, before pivoting to widget manufacturing and",
  "expanding across seventeen countries with hundreds of retail partners.",
].join("\n");

/** Simulate an old database migrated before fs_blob_chunks existed. */
function missingChunkTableClient(real: SqlClient): SqlClient {
  return {
    query(text, params) {
      if (text.includes("fs_blob_chunks")) {
        throw new SqlError(
          'relation "fs_blob_chunks" does not exist',
          "42P01",
        );
      }
      return real.query(text, params);
    },
    transaction(fn) {
      return real.transaction((tx) => fn(missingChunkTableClient(tx)));
    },
  };
}

describe.each(TEST_ADAPTERS)("searchChunks [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
    // The global setup runs with FTS off; layer the bm25 indexes on top
    // (idempotent — this is exactly the documented migration path).
    await setup(client, { enableRLS: false, enableFullTextSearch: true });
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(client, WS);
    fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await fs.init();
  });

  it("ranks the dedicated section above a passing mention, with line-range addressing", async () => {
    await fs.writeFile("/content/about.md", ABOUT);
    await fs.writeFile("/content/misc.md", MISC);

    const hits = await fs.searchChunks("shipping");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatchObject({
      path: "/content/about.md",
      headingPath: "Widget Co > Shipping",
    });
    expect(hits[0]!.rank).toBeGreaterThan(hits.at(-1)!.rank);

    // Every hit hydrates: its line range re-reads to the indexed body.
    for (const hit of hits) {
      const { content } = await fs.readFileLines(hit.path, {
        offset: hit.startLine,
        limit: hit.endLine - hit.startLine + 1,
      });
      expect(hit.content.endsWith(content)).toBe(true);
    }
  });

  it("returns one hit per matching section of the same file", async () => {
    await fs.writeFile(
      "/a.md",
      "# Doc\n\n## Alpha\n\npricing details here\n\n## Beta\n\nmore pricing details",
    );
    const hits = await fs.searchChunks("pricing");
    const ranges = hits
      .filter((h) => h.path === "/a.md")
      .map((h) => `${h.startLine}-${h.endLine}`);
    expect(new Set(ranges).size).toBe(2);
  });

  it("returns nothing for a term that appears nowhere", async () => {
    await fs.writeFile("/a.md", ABOUT);
    expect(await fs.searchChunks("zeppelin")).toEqual([]);
  });

  it("scopes to a path subtree and respects the limit", async () => {
    await fs.writeFile("/content/a.md", "# A\n\npricing info");
    await fs.writeFile("/docs/b.md", "# B\n\npricing info");

    const scoped = await fs.searchChunks("pricing", { path: "/content" });
    expect(scoped.map((h) => h.path)).toEqual(["/content/a.md"]);

    const limited = await fs.searchChunks("pricing", { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("projects hits onto the visible version (fork, then promote)", async () => {
    await fs.writeFile("/a.md", "# A\n\n## Shipping\n\nfree shipping");
    const forked = await fs.fork("crawl");
    await forked.writeFile("/a.md", "# A\n\n## Returns\n\nthirty day returns");

    // Each side sees only its own blob's chunks at /a.md.
    expect((await fs.searchChunks("shipping"))[0]!.path).toBe("/a.md");
    expect(await fs.searchChunks("returns")).toEqual([]);
    expect((await forked.searchChunks("returns"))[0]!.path).toBe("/a.md");
    expect(await forked.searchChunks("shipping")).toEqual([]);

    // After promotion the new main sees the crawl content, not the stale blob.
    await forked.promoteTo("main");
    const promoted = new PgFileSystem({ db: client, workspaceId: WS });
    expect((await promoted.searchChunks("returns"))[0]!.path).toBe("/a.md");
    expect(await promoted.searchChunks("shipping")).toEqual([]);
  });

  it("honors excludes and mounts", async () => {
    await fs.writeFile("/content/a.md", "# A\n\npricing info");
    await fs.writeFile("/secret.md", "# S\n\npricing info");

    const excluded = new PgFileSystem({
      db: client,
      workspaceId: WS,
      exclude: ["secret.md"],
    });
    expect(
      (await excluded.searchChunks("pricing")).map((h) => h.path),
    ).toEqual(["/content/a.md"]);

    const mounted = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [{ path: "/content" }],
    });
    expect(
      (await mounted.searchChunks("pricing")).map((h) => h.path),
    ).toEqual(["/content/a.md"]);
  });

  it("isolates workspaces", async () => {
    const OTHER = "chunk-search-other";
    await resetWorkspace(client, OTHER);
    const other = new PgFileSystem({
      db: client,
      workspaceId: OTHER,
      chunking: true,
    });
    await other.init();
    await other.writeFile("/a.md", "# A\n\nzeppelin facts");

    expect(await fs.searchChunks("zeppelin")).toEqual([]);
    expect((await other.searchChunks("zeppelin"))[0]!.path).toBe("/a.md");
    await resetWorkspace(client, OTHER);
  });

  it("does not surface chunk-less content (written without the option, not backfilled)", async () => {
    const plain = new PgFileSystem({ db: client, workspaceId: WS });
    await plain.init();
    await plain.writeFile("/old.md", "# Old\n\nzeppelin facts");
    expect(await fs.searchChunks("zeppelin")).toEqual([]);

    await fs.backfillChunks();
    expect((await fs.searchChunks("zeppelin"))[0]!.path).toBe("/old.md");
  });

  it("fails fast with the migration story when the table is missing", async () => {
    await fs.writeFile("/a.md", ABOUT); // real init + content via the real client
    const old = new PgFileSystem({
      db: missingChunkTableClient(client),
      workspaceId: WS,
    });
    await expect(old.searchChunks("shipping")).rejects.toThrow(
      /fs_blob_chunks table does not exist.*setup\(\)/s,
    );
  });
});
