import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { SqlError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

const WS = "vector-search-workspace";

/**
 * Deterministic "semantic" space: three concept dimensions keyed on
 * vocabulary, with a small floor so no vector is ever zero. Synonyms land on
 * the same dimension ("delivery" ≈ "ship") even when they share no token —
 * exactly the blind spot BM25 has and the vector side must cover.
 */
function vocabEmbed(text: string): number[] {
  const t = text.toLowerCase();
  return [
    /ship|deliver/.test(t) ? 1 : 0.05,
    /return|refund/.test(t) ? 1 : 0.05,
    /widget/.test(t) ? 1 : 0.05,
  ];
}

/** Simulate a database migrated without vector search. */
function missingEmbeddingTableClient(real: SqlClient): SqlClient {
  return {
    query(text, params) {
      if (text.includes("fs_chunk_embeddings")) {
        throw new SqlError(
          'relation "fs_chunk_embeddings" does not exist',
          "42P01",
        );
      }
      return real.query(text, params);
    },
    transaction(fn) {
      return real.transaction((tx) => fn(missingEmbeddingTableClient(tx)));
    },
  };
}

/** Simulate a database set up with enableFullTextSearch: false. */
function missingBm25IndexClient(real: SqlClient): SqlClient {
  return {
    query(text, params) {
      if (text.includes("to_bm25query")) {
        throw new SqlError(
          'index "idx_fs_blob_chunks_content_bm25" does not exist',
          "42704",
        );
      }
      return real.query(text, params);
    },
    transaction(fn) {
      return real.transaction((tx) => fn(missingBm25IndexClient(tx)));
    },
  };
}

describe.each(TEST_ADAPTERS)("semanticSearch & hybridSearch [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;

  // One embedder for everything: the same batch `embed` option serves the
  // indexing pass and (as single-item batches) the query side.
  const makeFs = () =>
    new PgFileSystem({
      db: client,
      workspaceId: WS,
      chunking: true,
      embed: async (texts) => texts.map(vocabEmbed),
      embeddingDimensions: 3,
    });

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
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
    await client.query(
      "DELETE FROM fs_chunk_embeddings WHERE workspace_id = $1",
      [WS],
    );
    fs = makeFs();
    await fs.init();
  });

  it("covers BM25's blind spot: a synonym query still finds the section", async () => {
    await fs.writeFile("/shipping.md", "## Shipping\n\nOrders ship free over fifty euros.");
    await fs.writeFile("/returns.md", "## Returns\n\nRefunds within thirty days.");
    await fs.indexChunkEmbeddings();

    // No document contains a "delivery" token — pure BM25 comes up empty.
    expect(await fs.textSearch("delivery")).toEqual([]);

    const hits = await fs.hybridSearch("delivery");
    expect(hits[0]).toMatchObject({ path: "/shipping.md" });
  });

  it("covers the vector's blind spot: an exact rare token beats the semantic decoy", async () => {
    // The code chunk's embedding points at "widget"; the decoy's is the
    // floor vector — which is what the (vocab-less) query embeds to, so the
    // vector ranking alone puts the decoy first. BM25 on the rare token
    // plus a small vector contribution must still win the fusion.
    await fs.writeFile("/codes.md", "## Support codes\n\nQuote widget code WBL-1234 to support.");
    await fs.writeFile("/about.md", "## About\n\nA small company from Milan.");
    await fs.indexChunkEmbeddings();

    const hits = await fs.hybridSearch("WBL-1234");
    expect(hits[0]).toMatchObject({ path: "/codes.md" });
    expect(hits[0]!.content).toContain("WBL-1234");
  });

  it("ranks a both-signal hit above single-signal hits (the RRF payoff)", async () => {
    // Query "WBL-1234 delivery": /a.md matches lexically AND semantically,
    // /codes.md lexically only, /b.md semantically only ("ship" ≈ "delivery").
    await fs.writeFile("/a.md", "## Delivery\n\nWBL-1234 forms arrive with each delivery.");
    await fs.writeFile("/b.md", "## Shipping\n\nOrders ship fast.");
    await fs.writeFile("/codes.md", "## Codes\n\nQuote code WBL-1234 to support.");
    await fs.indexChunkEmbeddings();

    const hits = await fs.hybridSearch("WBL-1234 delivery");
    expect(hits[0]!.path).toBe("/a.md");
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("/b.md"); // vector-only hit survives
    expect(paths).toContain("/codes.md"); // text-only hit survives
  });

  it("caps hits per file so one long page can't monopolize the top-k", async () => {
    const faq = [
      "# FAQ",
      "",
      ...Array.from({ length: 5 }, (_, i) =>
        `## Question ${i}\n\npricing details number ${i}\n`,
      ),
    ].join("\n");
    await fs.writeFile("/faq.md", faq);
    await fs.writeFile("/other.md", "## Plans\n\npricing overview");
    await fs.indexChunkEmbeddings();

    const capped = await fs.hybridSearch("pricing");
    expect(capped.filter((h) => h.path === "/faq.md").length).toBeLessThanOrEqual(3);
    expect(capped.some((h) => h.path === "/other.md")).toBe(true);

    const one = await fs.hybridSearch("pricing", { perFileCap: 1 });
    expect(one.filter((h) => h.path === "/faq.md")).toHaveLength(1);
    expect(one.some((h) => h.path === "/other.md")).toBe(true);
  });

  it("reaches unembedded chunks through the lexical side", async () => {
    // The crawl has run but the embedding pass hasn't — text hits must not
    // vanish just because the vector side knows nothing yet.
    await fs.writeFile("/a.md", "## Pricing\n\npremium plan costs nine euros");
    const hits = await fs.hybridSearch("premium");
    expect(hits[0]).toMatchObject({ path: "/a.md" });
  });

  it("projects hits onto the visible version (fork, then promote)", async () => {
    await fs.writeFile("/a.md", "## Shipping\n\nfree shipping");
    const forked = await fs.fork("crawl");
    await forked.writeFile("/a.md", "## Returns\n\nthirty day returns");
    await fs.indexChunkEmbeddings(); // workspace-wide: covers both blobs

    // The vector side is nearest-neighbor — it always ranks something — so
    // visibility shows in WHICH blob's chunks surface at /a.md, never in an
    // empty result: each side must only ever see its own version's content.
    expect((await fs.hybridSearch("shipping"))[0]!.path).toBe("/a.md");
    for (const hit of await fs.hybridSearch("thirty day returns")) {
      expect(hit.content).not.toContain("thirty");
    }
    expect((await forked.hybridSearch("thirty"))[0]!.content).toContain(
      "thirty day returns",
    );

    await forked.promoteTo("main");
    const promoted = makeFs();
    const after = await promoted.hybridSearch("returns");
    expect(after[0]!.content).toContain("thirty day returns");
    for (const hit of after) {
      expect(hit.content).not.toContain("free shipping");
    }
  });

  it("honors scope, limit, excludes and mounts", async () => {
    await fs.writeFile("/content/a.md", "## A\n\npricing info");
    await fs.writeFile("/secret.md", "## S\n\npricing info");
    await fs.indexChunkEmbeddings();

    const scoped = await fs.hybridSearch("pricing", { path: "/content" });
    expect(scoped.map((h) => h.path)).toEqual(["/content/a.md"]);

    expect(await fs.hybridSearch("pricing", { limit: 1 })).toHaveLength(1);

    const excluded = new PgFileSystem({
      db: client,
      workspaceId: WS,
      exclude: ["secret.md"],
      embed: async (texts) => texts.map(vocabEmbed),
    });
    expect(
      (await excluded.hybridSearch("pricing")).map((h) => h.path),
    ).toEqual(["/content/a.md"]);

    const mounted = new PgFileSystem({
      db: client,
      workspaceId: WS,
      mount: [{ path: "/content" }],
      embed: async (texts) => texts.map(vocabEmbed),
    });
    expect(
      (await mounted.hybridSearch("pricing")).map((h) => h.path),
    ).toEqual(["/content/a.md"]);
  });

  it("semanticSearch: ranks by vector similarity alone, synonyms included", async () => {
    await fs.writeFile("/shipping.md", "## Shipping\n\nOrders ship free over fifty euros.");
    await fs.writeFile("/returns.md", "## Returns\n\nRefunds within thirty days.");
    await fs.indexChunkEmbeddings();

    // Synonym: no shared token, same concept dimension.
    const hits = await fs.semanticSearch("delivery");
    expect(hits[0]).toMatchObject({ path: "/shipping.md" });
    expect(hits[0]!.rank).toBeGreaterThan(hits.at(-1)!.rank);

    // Unembedded content is invisible to the pure vector signal.
    await fs.writeFile("/new.md", "## New\n\nOrders ship overnight too.");
    const paths = (await fs.semanticSearch("delivery")).map((h) => h.path);
    expect(paths).not.toContain("/new.md");
  });

  it("semanticSearch: honors scope and the per-file cap", async () => {
    const faq = [
      "# FAQ",
      "",
      ...Array.from(
        { length: 5 },
        (_, i) => `## Shipping ${i}\n\nOrders ship, question ${i}\n`,
      ),
    ].join("\n");
    await fs.writeFile("/faq.md", faq);
    await fs.writeFile("/content/a.md", "## Delivery\n\nOrders ship fast.");
    await fs.indexChunkEmbeddings();

    const capped = await fs.semanticSearch("delivery");
    expect(
      capped.filter((h) => h.path === "/faq.md").length,
    ).toBeLessThanOrEqual(3);
    expect(capped.some((h) => h.path === "/content/a.md")).toBe(true);

    const scoped = await fs.semanticSearch("delivery", { path: "/content" });
    expect(scoped.map((h) => h.path)).toEqual(["/content/a.md"]);
  });

  it("guards: embedder required, dimensions validated, setup stories on missing schema", async () => {
    const none = new PgFileSystem({ db: client, workspaceId: WS });
    await expect(none.hybridSearch("x")).rejects.toThrow(
      /embedding provider/,
    );
    await expect(none.semanticSearch("x")).rejects.toThrow(
      /embedding provider/,
    );

    const wrongDims = new PgFileSystem({
      db: client,
      workspaceId: WS,
      embed: async (texts) => texts.map(() => [1, 2]),
      embeddingDimensions: 3,
    });
    await expect(wrongDims.hybridSearch("x")).rejects.toThrow(
      /dimension mismatch/i,
    );

    await fs.writeFile("/a.md", "## A\n\npricing info");
    const noVector = new PgFileSystem({
      db: missingEmbeddingTableClient(client),
      workspaceId: WS,
      embed: async (texts) => texts.map(vocabEmbed),
    });
    await expect(noVector.hybridSearch("pricing")).rejects.toThrow(
      /enableVectorSearch/,
    );
    await expect(noVector.semanticSearch("pricing")).rejects.toThrow(
      /enableVectorSearch/,
    );

    const noFts = new PgFileSystem({
      db: missingBm25IndexClient(client),
      workspaceId: WS,
      embed: async (texts) => texts.map(vocabEmbed),
    });
    await expect(noFts.hybridSearch("pricing")).rejects.toThrow(
      /enableFullTextSearch/,
    );
  });
});
