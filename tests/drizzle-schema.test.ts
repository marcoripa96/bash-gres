import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type postgres from "postgres";
import { createSchema } from "../lib/adapters/drizzle/schema.js";
import { ensureSetup } from "./global-setup.js";
import { createTestSql } from "./helpers.js";

const WS = "drizzle-schema-test";

describe("createSchema drizzle typing", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureSetup();
    sql = createTestSql();
  });

  afterAll(async () => {
    await sql.end();
  });

  it("keeps fs_blobs usable in queries when vector search is off", async () => {
    const db = drizzle(sql);
    const schema = createSchema({
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
    // Regression: the embedding column used to be built with a conditional
    // spread, which typed it as *optional* and broke drizzle's table
    // constraint — select()/delete() on fsBlobs would not compile at all.
    const rows = await db
      .select({ hash: schema.fsBlobs.hash })
      .from(schema.fsBlobs)
      .where(eq(schema.fsBlobs.workspaceId, WS))
      .limit(1);
    expect(rows).toEqual([]);
    await db.delete(schema.fsBlobs).where(eq(schema.fsBlobs.workspaceId, WS));
  });

  it("adds the fs_chunk_embeddings table only when vector search is on", () => {
    const schema = createSchema({
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
    // Statically a real table, and present at runtime.
    expect(schema.fsChunkEmbeddings.embedding.name).toBe("embedding");
    expect("fsChunkEmbeddings" in createSchema()).toBe(false);
    expect(() => createSchema({ enableVectorSearch: true })).toThrow(
      "embeddingDimensions is required",
    );
  });

  it("declares the workspace_isolation policy on every table by default", () => {
    const schema = createSchema({
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const names = config.policies.map((p) => p.name);
      expect(names, config.name).toEqual(["workspace_isolation"]);
      expect(config.policies[0]?.for).toBe("all");
      expect(config.policies[0]?.using).toBeDefined();
      expect(config.policies[0]?.withCheck).toBeDefined();
    }
  });

  it("omits the policies with enableRLS: false", () => {
    const schema = createSchema({ enableRLS: false });
    for (const table of Object.values(schema)) {
      expect(getTableConfig(table).policies).toEqual([]);
    }
  });

  it("declares the fs_blob_chunks FK to fs_blobs with the core DDL's name", () => {
    const schema = createSchema();
    const fks = getTableConfig(schema.fsBlobChunks).foreignKeys;
    expect(fks).toHaveLength(1);
    const fk = fks[0]!;
    expect(fk.getName()).toBe("fs_blob_chunks_blob_fkey");
    expect(fk.onDelete).toBe("cascade");
    const ref = fk.reference();
    expect(ref.foreignTable).toBe(schema.fsBlobs);
    expect(ref.columns.map((c) => c.name)).toEqual([
      "workspace_id",
      "blob_hash",
    ]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual([
      "workspace_id",
      "hash",
    ]);
  });
});
