import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { SqlError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

const WS = "chunk-embed-workspace";

const PAGE = (fetchedAt: string, team = "Two hundred people.") =>
  [
    "---",
    'title: "Widget Co"',
    `fetchedAt: ${fetchedAt}`,
    "---",
    "",
    "We build widgets.",
    "",
    "## Shipping",
    "",
    "Free over fifty euros.",
    "",
    "## Team",
    "",
    team,
  ].join("\n");

/** Batch embedder double: records every call, returns deterministic dim-3 vectors. */
function fakeEmbedder(dims = 3) {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts: string[]): Promise<number[][]> => {
      calls.push(texts);
      return texts.map((t) => Array.from({ length: dims }, (_, i) => (t.length % (i + 3)) / 10));
    },
  };
}

async function cacheRowCount(client: SqlClient, ws: string): Promise<number> {
  const r = await client.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM fs_chunk_embeddings WHERE workspace_id = $1",
    [ws],
  );
  return Number(r.rows[0]?.count ?? 0);
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

describe.each(TEST_ADAPTERS)("indexChunkEmbeddings [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;

  const makeFs = (embed?: (texts: string[]) => Promise<number[][]>) =>
    new PgFileSystem({
      db: client,
      workspaceId: WS,
      chunking: { volatileFrontmatterKeys: ["fetchedAt"] },
      embed,
      embeddingDimensions: 3,
    });

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(client, WS);
    // No FK ties the cache to chunk rows (by design), so resetWorkspace
    // doesn't reach it — clear it explicitly.
    await client.query(
      "DELETE FROM fs_chunk_embeddings WHERE workspace_id = $1",
      [WS],
    );
  });

  it("embeds every distinct chunk content once, in one batch", async () => {
    const { calls, embed } = fakeEmbedder();
    const fs = makeFs(embed);
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));

    const result = await fs.indexChunkEmbeddings();
    expect(result.chunks).toBeGreaterThan(0);
    expect(result).toMatchObject({
      embedded: result.chunks,
      cacheHits: 0,
    });
    expect(calls).toHaveLength(1); // one batch, not one call per chunk
    expect(await cacheRowCount(client, WS)).toBe(result.chunks);
  });

  it("re-embeds only the edited section (the two-level dedup)", async () => {
    const { calls, embed } = fakeEmbedder();
    const fs = makeFs(embed);
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));
    const first = await fs.indexChunkEmbeddings();

    // Edit one section of the page; everything else is byte-identical.
    await fs.writeFile("/a.md", PAGE("2026-01-01", "Three hundred people."));
    calls.length = 0;
    const second = await fs.indexChunkEmbeddings();

    expect(second.embedded).toBe(1);
    expect(second.cacheHits).toBe(first.chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]![0]).toContain("Three hundred people.");
  });

  it("volatile front matter alone triggers no re-embedding (re-crawl case)", async () => {
    const { calls, embed } = fakeEmbedder();
    const fs = makeFs(embed);
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));
    await fs.indexChunkEmbeddings();

    // A re-crawl rewrites the page with a fresh fetchedAt and nothing else:
    // new blob, new chunk rows — but identical indexed contents.
    await fs.writeFile("/a.md", PAGE("2026-08-12"));
    calls.length = 0;
    const result = await fs.indexChunkEmbeddings();
    expect(result.embedded).toBe(0);
    expect(result.cacheHits).toBe(result.chunks);
    expect(calls).toHaveLength(0);
  });

  it("identical sections in different files share one cached vector", async () => {
    const { calls, embed } = fakeEmbedder();
    const fs = makeFs(embed);
    await fs.init();
    const common = "## Common\n\nshared paragraph";
    await fs.writeFile("/a.md", `# T\n\n${common}\n\n## OnlyA\n\naaa`);
    await fs.writeFile("/b.md", `# T\n\n${common}\n\n## OnlyB\n\nbbb`);

    await fs.indexChunkEmbeddings();
    const sent = calls.flat();
    expect(sent.filter((t) => t.includes("shared paragraph"))).toHaveLength(1);
  });

  it("is idempotent and survives losing the chunk rows (no FK by design)", async () => {
    const { calls, embed } = fakeEmbedder();
    const fs = makeFs(embed);
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));
    const first = await fs.indexChunkEmbeddings();

    calls.length = 0;
    expect(await fs.indexChunkEmbeddings()).toEqual({
      chunks: first.chunks,
      cacheHits: first.chunks,
      embedded: 0,
    });
    expect(calls).toHaveLength(0);

    // Simulate a blob sweep: chunk rows cascade away, the cache stays.
    await client.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [WS]);
    expect(await cacheRowCount(client, WS)).toBe(first.chunks);

    // The same content re-crawled re-chunks but never re-embeds.
    const fs2 = makeFs(embed);
    await fs2.init();
    await fs2.writeFile("/a.md", PAGE("2026-02-02"));
    const after = await fs2.indexChunkEmbeddings();
    expect(after.embedded).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("isolates workspaces: the cache never leaks across them", async () => {
    const OTHER = "chunk-embed-other";
    await resetWorkspace(client, OTHER);
    await client.query(
      "DELETE FROM fs_chunk_embeddings WHERE workspace_id = $1",
      [OTHER],
    );
    const a = fakeEmbedder();
    const fs = makeFs(a.embed);
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));
    await fs.indexChunkEmbeddings();

    const b = fakeEmbedder();
    const other = new PgFileSystem({
      db: client,
      workspaceId: OTHER,
      chunking: { volatileFrontmatterKeys: ["fetchedAt"] },
      embed: b.embed,
      embeddingDimensions: 3,
    });
    await other.init();
    await other.writeFile("/a.md", PAGE("2026-01-01"));
    const result = await other.indexChunkEmbeddings();
    expect(result.cacheHits).toBe(0); // same content, but no cross-workspace hits
    expect(result.embedded).toBe(result.chunks);
    await resetWorkspace(client, OTHER);
    await client.query(
      "DELETE FROM fs_chunk_embeddings WHERE workspace_id = $1",
      [OTHER],
    );
  });

  it("validates the embedder's output shape", async () => {
    const fs = makeFs(async (texts) => texts.map(() => [1, 2])); // wrong dims
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));
    await expect(fs.indexChunkEmbeddings()).rejects.toThrow(
      /dimension mismatch/i,
    );

    const short = makeFs(async () => [[1, 2, 3]]); // one vector for N texts
    await expect(short.indexChunkEmbeddings()).rejects.toThrow(
      /vectors for/,
    );
  });

  it("guards: requires the embedder, write permission, and the cache table", async () => {
    const none = makeFs(undefined);
    await expect(none.indexChunkEmbeddings()).rejects.toThrow(/embed/);

    const readonly = new PgFileSystem({
      db: client,
      workspaceId: WS,
      embed: async (t) => t.map(() => [0, 0, 0]),
      permissions: { read: true, write: false },
    });
    await expect(readonly.indexChunkEmbeddings()).rejects.toThrow(
      /EPERM|read-only/,
    );

    const fs = makeFs(fakeEmbedder().embed);
    await fs.init();
    await fs.writeFile("/a.md", PAGE("2026-01-01"));
    const old = new PgFileSystem({
      db: missingEmbeddingTableClient(client),
      workspaceId: WS,
      embed: async (t) => t.map(() => [0, 0, 0]),
    });
    await expect(old.indexChunkEmbeddings()).rejects.toThrow(
      /enableVectorSearch/,
    );
  });
});
