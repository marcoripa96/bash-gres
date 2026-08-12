import type { SqlClient, ChunkSearchResult, SqlParam } from "./types.js";
import { SqlError } from "./types.js";
import { pathToLtree, ltreeToPath } from "./path-encoding.js";
import {
  emptyExcludes,
  excludeWhereSql,
  type CompiledExcludes,
} from "./exclude.js";
import {
  emptyMounts,
  mountWhereSql,
  type CompiledMounts,
} from "./mounts.js";

const MAX_SEARCH_LIMIT = 100;
const VISIBILITY_OVERSAMPLE = 4;

// Reciprocal-rank fusion constant (Cormack et al.'s standard 60). Hybrid
// search fuses ranks, not scores: BM25 scores and cosine similarities live
// on incomparable scales, and the two rankings come from different tables
// with different coverage (a chunk may be unembedded, or lexically
// unmatched) — rank fusion is scale-free and lets either signal carry a hit
// the other side missed, where weighted score blending would drop it.
const RRF_K = 60;
const DEFAULT_PER_FILE_CAP = 3;

// BM25 scoring must name the index that supplies the corpus statistics:
// the single-argument to_bm25query() form only resolves the index when the
// query string is an inline literal the planner can const-fold — with a
// bound parameter (how every adapter sends queries) it errors "operator
// requires index" regardless of plan (pg_textsearch v1.0.0). The name is
// fixed by our own DDL in setup.ts.
const CHUNK_BM25_INDEX = "idx_fs_blob_chunks_content_bm25";

/**
 * Turn pg_textsearch's "index ... does not exist" (42704) for our bm25
 * index into the setup story: the database was set up with
 * `enableFullTextSearch: false` (or by a bash-gres too old to have the
 * chunk index).
 */
function rethrowMissingBm25Index(e: unknown): never {
  if (
    e instanceof SqlError &&
    e.code === "42704" &&
    e.message.includes(CHUNK_BM25_INDEX)
  ) {
    throw new Error(
      "BM25 search requires the full-text-search setup — re-run setup() " +
        "(idempotent) with enableFullTextSearch: true to create the bm25 index",
    );
  }
  throw e;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const val = limit ?? fallback;
  if (!Number.isFinite(val)) return fallback;
  return Math.min(Math.max(1, Math.floor(val)), MAX_SEARCH_LIMIT);
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

export interface ChunkSearchOpts {
  path?: string;
  limit?: number;
  /** Max hits per file path (default 3) so one long page can't monopolize the top-k. */
  perFileCap?: number;
  excludes?: CompiledExcludes;
  mounts?: CompiledMounts;
}

/**
 * The version-visibility projection every version-scoped chunk operation
 * shares — searches and the maintenance passes alike: the nearest entry per
 * path along version $2's ancestor chain (so shadowed blobs and tombstoned
 * paths never count), scoped to the $3 subtree and filtered by the
 * instance's excludes/mounts. Yields (path, blob_hash, node_type); callers
 * must still keep only `node_type = 'file'` rows. References $1
 * (workspace), $2 (version) and $3 (scope ltree); the exclude/mount params
 * returned here are numbered from `paramStart`.
 */
export function visibleEntriesSql(
  excludes: CompiledExcludes | undefined,
  mounts: CompiledMounts | undefined,
  paramStart: number,
): { sql: string; params: SqlParam[] } {
  const exc = excludeWhereSql(
    excludes ?? emptyExcludes(),
    "e.path",
    paramStart,
  );
  const mnt = mountWhereSql(
    mounts ?? emptyMounts(),
    "e.path",
    paramStart + exc.params.length,
  );
  return {
    sql: `SELECT DISTINCT ON (e.path)
         e.path::text AS path,
         e.blob_hash,
         e.node_type
       FROM fs_entries e
       JOIN version_ancestors a
         ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
       WHERE e.workspace_id = $1
         AND a.descendant_id = $2
         AND e.path <@ $3::ltree
         AND ${exc.sql}
         AND ${mnt.sql}
       ORDER BY e.path, a.depth ASC`,
    params: [...exc.params, ...mnt.params],
  };
}

/**
 * Every search shares one two-stage shape: a signal-specific `candidates`
 * CTE ranks chunks workspace-wide to the oversample depth, then the shared
 * tail projects them onto paths visible at version V (fs_entries +
 * version_ancestors), caps hits per file, and applies the final limit.
 *
 * Recall is approximate under heavy version divergence — a top-K candidate
 * whose blob is not visible in V is dropped. `VISIBILITY_OVERSAMPLE`
 * compensates for the common case (mild divergence), and feeds the per-file
 * cap enough surplus to backfill from other files.
 *
 * The candidates CTE must produce (blob_hash, start_line, end_line,
 * heading_path, content, rank) and may reference $1 (workspace), $4
 * (oversample limit) and its own signal params from $7 up.
 */
async function runChunkSearch(
  client: SqlClient,
  candidatesSql: string,
  signalParams: SqlParam[],
  workspaceId: string,
  versionId: number,
  opts: ChunkSearchOpts | undefined,
): Promise<ChunkSearchResult[]> {
  const limit = clampLimit(opts?.limit, 20);
  const perFileCap = clampLimit(opts?.perFileCap, DEFAULT_PER_FILE_CAP);
  const scopeLtree = pathToLtree(opts?.path ?? "/", workspaceId);
  const fetchLimit = limit * VISIBILITY_OVERSAMPLE;

  const baseParams: SqlParam[] = [
    workspaceId,
    versionId,
    scopeLtree,
    fetchLimit,
    limit,
    perFileCap,
    ...signalParams,
  ];
  const vis = visibleEntriesSql(
    opts?.excludes,
    opts?.mounts,
    baseParams.length + 1,
  );

  let result;
  try {
    result = await client.query<{
      path: string;
      start_line: number;
      end_line: number;
      heading_path: string | null;
      content: string;
      rank: number;
    }>(
      `WITH ${candidatesSql},
     visible AS (
       ${vis.sql}
     ),
     hits AS (
       SELECT v.path, c.start_line, c.end_line, c.heading_path, c.content,
              c.rank,
              ROW_NUMBER() OVER (
                PARTITION BY v.path
                ORDER BY c.rank DESC, c.start_line
              ) AS file_rank
       FROM visible v
       JOIN candidates c ON c.blob_hash = v.blob_hash
       WHERE v.node_type = 'file'
     )
     SELECT path, start_line, end_line, heading_path, content, rank
     FROM hits
     WHERE file_rank <= $6
     ORDER BY rank DESC, path, start_line
     LIMIT $5`,
      [...baseParams, ...vis.params],
    );
  } catch (e) {
    rethrowMissingBm25Index(e);
  }

  return result.rows.map((r) => ({
    path: ltreeToPath(r.path),
    startLine: Number(r.start_line),
    endLine: Number(r.end_line),
    headingPath: r.heading_path,
    content: r.content,
    rank: Number(r.rank),
  }));
}

/**
 * BM25 search at version V: lexical hits rank sections. A blob visible at
 * several paths yields one hit per (path, chunk); a blob with several
 * matching chunks yields one hit per chunk (up to the per-file cap).
 * Non-matching rows score 0 and are filtered out.
 */
export async function chunkTextSearch(
  client: SqlClient,
  workspaceId: string,
  versionId: number,
  query: string,
  opts?: ChunkSearchOpts,
): Promise<ChunkSearchResult[]> {
  return runChunkSearch(
    client,
    `text_scored AS (
       SELECT c.blob_hash, c.chunk_index, c.start_line, c.end_line,
              c.heading_path, c.content,
              -(c.content <@> to_bm25query($7, '${CHUNK_BM25_INDEX}')) AS rank
       FROM fs_blob_chunks c
       WHERE c.workspace_id = $1
     ),
     candidates AS (
       SELECT blob_hash, start_line, end_line, heading_path, content, rank
       FROM text_scored
       WHERE rank > 0
       ORDER BY rank DESC, blob_hash, chunk_index
       LIMIT $4
     )`,
    [query],
    workspaceId,
    versionId,
    opts,
  );
}

/**
 * Vector search at version V: chunks ranked by cosine similarity between
 * the query embedding and the per-content cache (`fs_chunk_embeddings`,
 * filled by `indexChunkEmbeddings()`). Nearest-neighbor: it always ranks
 * something, so irrelevant queries return low-rank hits, not nothing.
 * Chunks without a cached embedding are invisible to this signal.
 */
export async function chunkSemanticSearch(
  client: SqlClient,
  workspaceId: string,
  versionId: number,
  embedding: number[],
  opts?: ChunkSearchOpts,
): Promise<ChunkSearchResult[]> {
  validateEmbedding(embedding);
  return runChunkSearch(
    client,
    `candidates AS (
       SELECT c.blob_hash, c.start_line, c.end_line, c.heading_path,
              c.content,
              1 - (emb.embedding <=> $7::vector) AS rank
       FROM fs_blob_chunks c
       JOIN fs_chunk_embeddings emb
         ON emb.workspace_id = c.workspace_id
        AND emb.content_hash = c.content_hash
       WHERE c.workspace_id = $1
       ORDER BY emb.embedding <=> $7::vector, c.blob_hash, c.chunk_index
       LIMIT $4
     )`,
    [`[${embedding.join(",")}]`],
    workspaceId,
    versionId,
    opts,
  );
}

/**
 * Hybrid search at version V: the BM25 and vector rankings, each taken to
 * the oversample depth, fused with reciprocal-rank fusion — see `RRF_K`
 * for why ranks rather than weighted scores. Chunks without a cached
 * embedding still surface through the lexical side.
 */
export async function chunkHybridSearch(
  client: SqlClient,
  workspaceId: string,
  versionId: number,
  query: string,
  embedding: number[],
  opts?: ChunkSearchOpts,
): Promise<ChunkSearchResult[]> {
  validateEmbedding(embedding);
  return runChunkSearch(
    client,
    `text_scored AS (
       SELECT c.blob_hash, c.chunk_index,
              -(c.content <@> to_bm25query($7, '${CHUNK_BM25_INDEX}')) AS score
       FROM fs_blob_chunks c
       WHERE c.workspace_id = $1
     ),
     text_ranked AS (
       SELECT blob_hash, chunk_index,
              ROW_NUMBER() OVER (
                ORDER BY score DESC, blob_hash, chunk_index
              ) AS r
       FROM text_scored
       WHERE score > 0
       ORDER BY r
       LIMIT $4
     ),
     vector_ranked AS (
       SELECT c.blob_hash, c.chunk_index,
              ROW_NUMBER() OVER (
                ORDER BY emb.embedding <=> $8::vector, c.blob_hash, c.chunk_index
              ) AS r
       FROM fs_blob_chunks c
       JOIN fs_chunk_embeddings emb
         ON emb.workspace_id = c.workspace_id
        AND emb.content_hash = c.content_hash
       WHERE c.workspace_id = $1
       ORDER BY r
       LIMIT $4
     ),
     fused AS (
       SELECT COALESCE(t.blob_hash, s.blob_hash) AS blob_hash,
              COALESCE(t.chunk_index, s.chunk_index) AS chunk_index,
              COALESCE(1.0 / (${RRF_K} + t.r), 0) +
              COALESCE(1.0 / (${RRF_K} + s.r), 0) AS rank
       FROM text_ranked t
       FULL JOIN vector_ranked s
         ON s.blob_hash = t.blob_hash AND s.chunk_index = t.chunk_index
     ),
     candidates AS (
       SELECT f.rank, c.blob_hash, c.start_line, c.end_line,
              c.heading_path, c.content
       FROM fused f
       JOIN fs_blob_chunks c
         ON c.workspace_id = $1
        AND c.blob_hash = f.blob_hash
        AND c.chunk_index = f.chunk_index
       ORDER BY f.rank DESC, c.blob_hash, c.chunk_index
       LIMIT $4
     )`,
    [query, `[${embedding.join(",")}]`],
    workspaceId,
    versionId,
    opts,
  );
}
