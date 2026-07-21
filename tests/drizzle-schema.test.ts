import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
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

  it("types the embedding column concretely when vector search is on", () => {
    const schema = createSchema({
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
    // Statically a real column (no optionality), and present at runtime.
    expect(schema.fsBlobs.embedding.name).toBe("embedding");
    expect(() => createSchema({ enableVectorSearch: true })).toThrow(
      "embeddingDimensions is required",
    );
  });
});
