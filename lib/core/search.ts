import type { SqlClient, SearchResult } from "./types.js";
import { pathToLtree, ltreeToPath } from "./path-encoding.js";

const MAX_SEARCH_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  const val = limit ?? 20;
  if (!Number.isFinite(val)) return 20;
  return Math.min(Math.max(1, val), MAX_SEARCH_LIMIT);
}

export function validateEmbedding(
  embedding: number[],
  expectedDimensions?: number,
): void {
  if (
    expectedDimensions !== undefined &&
    embedding.length !== expectedDimensions
  ) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expectedDimensions}, got ${embedding.length}`,
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new Error(
        `Embedding contains non-finite value at index ${i}: ${embedding[i]}`,
      );
    }
  }
}

export async function fullTextSearch(
  client: SqlClient,
  workspaceId: string,
  version: string,
  query: string,
  opts?: { path?: string; limit?: number },
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = pathToLtree(opts?.path ?? "/", workspaceId);

  const result = await client.query<{
    path: string;
    name: string;
    rank: number;
  }>(
    `SELECT
       path::text AS path,
       name,
       -(content <@> to_bm25query($1)) AS rank
     FROM fs_nodes
     WHERE workspace_id = $2
       AND version = $3
       AND path <@ $4::ltree
       AND node_type = 'file'
       AND content IS NOT NULL
       AND binary_data IS NULL
     ORDER BY content <@> to_bm25query($1)
     LIMIT $5`,
    [query, workspaceId, version, scopeLtree, limit],
  );

  return result.rows.map((r) => ({
    path: ltreeToPath(r.path),
    name: r.name,
    rank: Number(r.rank),
  }));
}

export async function semanticSearch(
  client: SqlClient,
  workspaceId: string,
  version: string,
  embedding: number[],
  opts?: { path?: string; limit?: number },
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = pathToLtree(opts?.path ?? "/", workspaceId);
  validateEmbedding(embedding);
  const embeddingStr = `[${embedding.join(",")}]`;

  const result = await client.query<{
    path: string;
    name: string;
    rank: number;
  }>(
    `SELECT
       path::text AS path,
       name,
       1 - (embedding <=> $1::vector) AS rank
     FROM fs_nodes
     WHERE workspace_id = $2
       AND version = $3
       AND path <@ $4::ltree
       AND node_type = 'file'
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $5`,
    [embeddingStr, workspaceId, version, scopeLtree, limit],
  );

  return result.rows.map((r) => ({
    path: ltreeToPath(r.path),
    name: r.name,
    rank: Number(r.rank),
  }));
}

export async function hybridSearch(
  client: SqlClient,
  workspaceId: string,
  version: string,
  query: string,
  embedding: number[],
  opts?: {
    path?: string;
    textWeight?: number;
    vectorWeight?: number;
    limit?: number;
  },
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const textWeight = opts?.textWeight ?? 0.4;
  const vectorWeight = opts?.vectorWeight ?? 0.6;

  if (!Number.isFinite(textWeight) || !Number.isFinite(vectorWeight)) {
    throw new Error("Search weights must be finite numbers");
  }

  const scopeLtree = pathToLtree(opts?.path ?? "/", workspaceId);
  validateEmbedding(embedding);
  const embeddingStr = `[${embedding.join(",")}]`;

  const result = await client.query<{
    path: string;
    name: string;
    rank: number;
  }>(
    `SELECT
       path::text AS path,
       name,
       ($1::float * (-(content <@> to_bm25query($2))) +
        $3::float * (1 - (embedding <=> $4::vector))) AS rank
     FROM fs_nodes
     WHERE workspace_id = $5
       AND version = $6
       AND path <@ $7::ltree
       AND node_type = 'file'
       AND content IS NOT NULL
       AND embedding IS NOT NULL
     ORDER BY rank DESC
     LIMIT $8`,
    [textWeight, query, vectorWeight, embeddingStr, workspaceId, version, scopeLtree, limit],
  );

  return result.rows.map((r) => ({
    path: ltreeToPath(r.path),
    name: r.name,
    rank: Number(r.rank),
  }));
}
