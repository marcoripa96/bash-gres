import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { SqlError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

const WS = "text-search-workspace";

const SHIPPING_DOC = [
  "# Shipping policy",
  "",
  "Shipping is free over fifty euros. Shipping takes two days.",
].join("\n");

// Long doc with one passing mention — BM25 must rank it below the dedicated doc.
const HISTORY_DOC = [
  "# Company history",
  "",
  "Founded in a garage, the company grew through wholesale partnerships,",
  "trade fairs, catalog sales, regional distribution centers, seasonal",
  "campaigns, loyalty programs, and one small note about shipping crates",
  "used in the early days, before pivoting to widget manufacturing.",
].join("\n");

/**
 * Deterministic 3-dim embedder: "shipping" and "delivery" share a dimension
 * so a lexical miss can still be a semantic hit in hybrid search.
 */
async function fakeEmbed(text: string): Promise<number[]> {
  const t = text.toLowerCase();
  return [
    t.includes("shipping") || t.includes("delivery") ? 1 : 0,
    t.includes("history") ? 1 : 0,
    0.1,
  ];
}

/** Simulate a database set up with enableFullTextSearch: false. */
function missingBm25IndexClient(real: SqlClient): SqlClient {
  return {
    query(text, params) {
      if (text.includes("to_bm25query")) {
        const name = text.includes("fs_blob_chunks")
          ? "idx_fs_blob_chunks_content_bm25"
          : "idx_fs_blobs_content_bm25";
        throw new SqlError(`index "${name}" does not exist`, "42704");
      }
      return real.query(text, params);
    },
    transaction(fn) {
      return real.transaction((tx) => fn(missingBm25IndexClient(tx)));
    },
  };
}

describe.each(TEST_ADAPTERS)("textSearch / hybridSearch [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
    // Layer FTS + vector search on the FTS-off global setup (idempotent).
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: true,
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(client, WS);
    fs = new PgFileSystem({ db: client, workspaceId: WS });
    await fs.init();
  });

  it("ranks a parameterized BM25 query on any plan (regression: single-arg to_bm25query)", async () => {
    // Small corpus → the planner seq-scans; the old single-arg form errored
    // with "operator requires index" for every bound-parameter query.
    await fs.writeFile("/shipping.md", SHIPPING_DOC);
    await fs.writeFile("/history.md", HISTORY_DOC);

    const hits = await fs.textSearch("shipping");
    expect(hits.map((h) => h.path)).toEqual(["/shipping.md", "/history.md"]);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
    expect(hits[0]!.name).toBe("shipping.md");

    expect(await fs.textSearch("zeppelin")).toEqual([]);
  });

  it("never matches binary or empty files", async () => {
    await fs.writeFile("/bin.dat", new TextEncoder().encode("shipping bytes"));
    await fs.writeFile("/empty.md", "");
    expect(await fs.textSearch("shipping")).toEqual([]);
  });

  it("scopes to a path subtree and respects the limit", async () => {
    await fs.writeFile("/content/a.md", "pricing info");
    await fs.writeFile("/docs/b.md", "pricing info");

    const scoped = await fs.textSearch("pricing", { path: "/content" });
    expect(scoped.map((h) => h.path)).toEqual(["/content/a.md"]);
    expect(await fs.textSearch("pricing", { limit: 1 })).toHaveLength(1);
  });

  it("projects hits onto the visible version (fork, then promote)", async () => {
    await fs.writeFile("/a.md", "free shipping today");
    const forked = await fs.fork("crawl");
    await forked.writeFile("/a.md", "thirty day returns");

    expect((await fs.textSearch("shipping"))[0]!.path).toBe("/a.md");
    expect(await fs.textSearch("returns")).toEqual([]);
    expect((await forked.textSearch("returns"))[0]!.path).toBe("/a.md");
    expect(await forked.textSearch("shipping")).toEqual([]);

    await forked.promoteTo("main");
    const promoted = new PgFileSystem({ db: client, workspaceId: WS });
    expect((await promoted.textSearch("returns"))[0]!.path).toBe("/a.md");
    expect(await promoted.textSearch("shipping")).toEqual([]);
  });

  it("honors excludes and mounts", async () => {
    await fs.writeFile("/content/a.md", "pricing info");
    await fs.writeFile("/secret.md", "pricing info");

    const excluded = new PgFileSystem({
      db: client,
      workspaceId: WS,
      exclude: ["secret.md"],
    });
    expect((await excluded.textSearch("pricing")).map((h) => h.path)).toEqual([
      "/content/a.md",
    ]);

    const mounted = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [{ path: "/content" }],
    });
    expect((await mounted.textSearch("pricing")).map((h) => h.path)).toEqual([
      "/content/a.md",
    ]);
  });

  it("isolates workspaces", async () => {
    const OTHER = "text-search-other";
    await resetWorkspace(client, OTHER);
    const other = new PgFileSystem({ db: client, workspaceId: OTHER });
    await other.init();
    await other.writeFile("/a.md", "zeppelin facts");

    expect(await fs.textSearch("zeppelin")).toEqual([]);
    expect((await other.textSearch("zeppelin"))[0]!.path).toBe("/a.md");
    await resetWorkspace(client, OTHER);
  });

  it("fails fast with the setup story when the bm25 index is missing", async () => {
    await fs.writeFile("/a.md", SHIPPING_DOC);
    const old = new PgFileSystem({
      db: missingBm25IndexClient(client),
      workspaceId: WS,
    });
    await expect(old.textSearch("shipping")).rejects.toThrow(
      /enableFullTextSearch/,
    );
    await expect(old.searchChunks("shipping")).rejects.toThrow(
      /enableFullTextSearch/,
    );
  });

  describe("hybridSearch", () => {
    let embedded: PgFileSystem;

    beforeEach(async () => {
      embedded = new PgFileSystem({
        db: client,
        workspaceId: WS,
        embed: fakeEmbed,
        embeddingDimensions: 3,
      });
      await embedded.writeFile("/shipping.md", SHIPPING_DOC);
      await embedded.writeFile("/history.md", HISTORY_DOC);
    });

    it("combines lexical and vector signals with a parameterized query", async () => {
      const hits = await embedded.hybridSearch("shipping");
      expect(hits[0]!.path).toBe("/shipping.md");
      expect(hits[0]!.rank).toBeGreaterThan(hits.at(-1)!.rank);
    });

    it("surfaces a semantic-only match (lexical score is 0, not an error)", async () => {
      // "delivery" appears in no document, but fakeEmbed maps it onto the
      // shipping dimension — the vector term must carry the hit alone.
      const hits = await embedded.hybridSearch("delivery");
      expect(hits[0]!.path).toBe("/shipping.md");
    });
  });
});
