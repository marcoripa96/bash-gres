import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { pathToLtree } from "../lib/core/path-encoding.js";
import type { SqlClient } from "./helpers.js";

const EMBEDDING_DIMS = 4;
const WORKSPACE_ID = "test-embedding";

const stubEmbed = async (text: string): Promise<number[]> => {
  // Deterministic, dimension-correct, non-zero vector. Content does not matter
  // for the test — only that the value lands in the row.
  const seed = text.length || 1;
  return [0.1 * seed, 0.2, 0.3, 0.4];
};

async function readBlobEmbedding(
  client: SqlClient,
  path: string,
): Promise<string | null> {
  const result = await client.query<{ embedding: string | null }>(
    `SELECT b.embedding::text AS embedding
     FROM fs_entries e
     JOIN fs_versions v
       ON v.workspace_id = e.workspace_id AND v.id = e.version_id
     JOIN fs_blobs b
       ON b.workspace_id = e.workspace_id AND b.hash = e.blob_hash
     WHERE e.workspace_id = $1 AND v.label = $2 AND e.path = $3::ltree`,
    [WORKSPACE_ID, "main", pathToLtree(path, WORKSPACE_ID)],
  );
  return result.rows[0]?.embedding ?? null;
}

describe.each(TEST_ADAPTERS)("embedding write [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
    // Idempotent: adds the embedding column + HNSW index if missing.
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: true,
      embeddingDimensions: EMBEDDING_DIMS,
    });
  });

  afterAll(async () => {
    try {
      await client.query("DROP INDEX IF EXISTS idx_fs_blobs_embedding");
      await client.query("ALTER TABLE fs_blobs DROP COLUMN IF EXISTS embedding");
    } finally {
      await teardown();
    }
  });

  beforeEach(async () => {
    await resetWorkspace(client, WORKSPACE_ID);
    fs = new PgFileSystem({
      db: client,
      workspaceId: WORKSPACE_ID,
      embed: stubEmbed,
      embeddingDimensions: EMBEDDING_DIMS,
    });
    await fs.init();
  });

  it("writeFile populates embedding column", async () => {
    await fs.writeFile("/note.txt", "hello world");

    expect(await readBlobEmbedding(client, "/note.txt")).not.toBeNull();
    expect(await fs.readFile("/note.txt")).toBe("hello world");
  });

  it("appendFile populates embedding when creating a new file", async () => {
    await fs.appendFile("/new.txt", "first chunk");

    expect(await readBlobEmbedding(client, "/new.txt")).not.toBeNull();
  });

  it("appendFile keeps existing embedding when appending to an existing file", async () => {
    await fs.writeFile("/existing.txt", "original");
    const before = await readBlobEmbedding(client, "/existing.txt");

    await fs.appendFile("/existing.txt", " more");
    const after = await readBlobEmbedding(client, "/existing.txt");

    expect(after).toBe(before);
    expect(await fs.readFile("/existing.txt")).toBe("original more");
  });
});
