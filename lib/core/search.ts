import type { SqlClient, SearchResult } from "./types.js";
import { pathToLtree, ltreeToPath, fileName } from "./path-encoding.js";

const MAX_SEARCH_LIMIT = 100;
const VISIBILITY_OVERSAMPLE = 4;

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

/**
 * BM25 full-text search at version V.
 *
 * Two-stage retrieval:
 *   1. Rank candidate blobs in this workspace by BM25 score (uses the global blob index).
 *   2. Project candidates onto visible paths in version V via fs_entries + version_ancestors.
 *
 * Recall is approximate under heavy version divergence — a top-K BM25 result whose
 * blob is not visible in V is dropped. We over-fetch by `VISIBILITY_OVERSAMPLE` to
 * compensate for the common case (mild divergence).
 */
export async function fullTextSearch(
  client: SqlClient,
  workspaceId: string,
  versionId: number,
  query: string,
  opts?: { path?: string; limit?: number },
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = pathToLtree(opts?.path ?? "/", workspaceId);
  const fetchLimit = limit * VISIBILITY_OVERSAMPLE;

  const result = await client.query<{
    path: string;
    rank: number;
  }>(
    `WITH candidates AS (
       SELECT b.hash, -(b.content <@> to_bm25query($1)) AS rank
       FROM fs_blobs b
       WHERE b.workspace_id = $2
         AND b.content IS NOT NULL
         AND b.binary_data IS NULL
       ORDER BY b.content <@> to_bm25query($1)
       LIMIT $5
     ),
     visible AS (
       SELECT DISTINCT ON (e.path)
         e.path::text AS path,
         e.blob_hash,
         e.node_type
       FROM fs_entries e
       JOIN version_ancestors a
         ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
       WHERE e.workspace_id = $2
         AND a.descendant_id = $3
         AND e.path <@ $4::ltree
       ORDER BY e.path, a.depth ASC
     )
     SELECT v.path, c.rank
     FROM visible v
     JOIN candidates c ON c.hash = v.blob_hash
     WHERE v.node_type = 'file'
     ORDER BY c.rank DESC
     LIMIT $6`,
    [query, workspaceId, versionId, scopeLtree, fetchLimit, limit],
  );

  return result.rows.map((r) => {
    const userPath = ltreeToPath(r.path);
    return {
      path: userPath,
      name: fileName(userPath),
      rank: Number(r.rank),
    };
  });
}

export async function semanticSearch(
  client: SqlClient,
  workspaceId: string,
  versionId: number,
  embedding: number[],
  opts?: { path?: string; limit?: number },
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = pathToLtree(opts?.path ?? "/", workspaceId);
  validateEmbedding(embedding);
  const embeddingStr = `[${embedding.join(",")}]`;
  const fetchLimit = limit * VISIBILITY_OVERSAMPLE;

  const result = await client.query<{
    path: string;
    rank: number;
  }>(
    `WITH candidates AS (
       SELECT b.hash, 1 - (b.embedding <=> $1::vector) AS rank
       FROM fs_blobs b
       WHERE b.workspace_id = $2 AND b.embedding IS NOT NULL
       ORDER BY b.embedding <=> $1::vector
       LIMIT $5
     ),
     visible AS (
       SELECT DISTINCT ON (e.path)
         e.path::text AS path,
         e.blob_hash,
         e.node_type
       FROM fs_entries e
       JOIN version_ancestors a
         ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
       WHERE e.workspace_id = $2
         AND a.descendant_id = $3
         AND e.path <@ $4::ltree
       ORDER BY e.path, a.depth ASC
     )
     SELECT v.path, c.rank
     FROM visible v
     JOIN candidates c ON c.hash = v.blob_hash
     WHERE v.node_type = 'file'
     ORDER BY c.rank DESC
     LIMIT $6`,
    [embeddingStr, workspaceId, versionId, scopeLtree, fetchLimit, limit],
  );

  return result.rows.map((r) => {
    const userPath = ltreeToPath(r.path);
    return {
      path: userPath,
      name: fileName(userPath),
      rank: Number(r.rank),
    };
  });
}

export async function hybridSearch(
  client: SqlClient,
  workspaceId: string,
  versionId: number,
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
  const fetchLimit = limit * VISIBILITY_OVERSAMPLE;

  const result = await client.query<{
    path: string;
    rank: number;
  }>(
    `WITH candidates AS (
       SELECT b.hash,
              ($1::float * (-(b.content <@> to_bm25query($2))) +
               $3::float * (1 - (b.embedding <=> $4::vector))) AS rank
       FROM fs_blobs b
       WHERE b.workspace_id = $5
         AND b.content IS NOT NULL
         AND b.embedding IS NOT NULL
       ORDER BY rank DESC
       LIMIT $8
     ),
     visible AS (
       SELECT DISTINCT ON (e.path)
         e.path::text AS path,
         e.blob_hash,
         e.node_type
       FROM fs_entries e
       JOIN version_ancestors a
         ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
       WHERE e.workspace_id = $5
         AND a.descendant_id = $6
         AND e.path <@ $7::ltree
       ORDER BY e.path, a.depth ASC
     )
     SELECT v.path, c.rank
     FROM visible v
     JOIN candidates c ON c.hash = v.blob_hash
     WHERE v.node_type = 'file'
     ORDER BY c.rank DESC
     LIMIT $9`,
    [
      textWeight,
      query,
      vectorWeight,
      embeddingStr,
      workspaceId,
      versionId,
      scopeLtree,
      fetchLimit,
      limit,
    ],
  );

  return result.rows.map((r) => {
    const userPath = ltreeToPath(r.path);
    return {
      path: userPath,
      name: fileName(userPath),
      rank: Number(r.rank),
    };
  });
}
