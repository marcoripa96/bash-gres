import type {
  CollectOrphanBlobsOptions,
  CollectOrphanBlobsResult,
} from "../../types.js";
import { tryExclusiveBlobGuard } from "../internals/blob-guard.js";
import { bytesKey } from "../internals/hashes.js";
import { op, type FilesystemOpsContext } from "./context.js";

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const BACKOFF_START_MS = 10;
const BACKOFF_MAX_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Blob `b` (of workspace `$1`) is unreferenced and older than the minimum
 * age in `minAgeParam` (milliseconds). The scalar subquery is never pulled up
 * into a join, so each blob gets one (workspace_id, blob_hash) index probe
 * that stops at the first reference (see delete-version-by-id).
 */
function orphanSql(minAgeParam: string): string {
  return `b.created_at < now() - ${minAgeParam}::float8 * interval '1 millisecond'
    AND (
      SELECT 1 FROM fs_entries
      WHERE workspace_id = $1 AND blob_hash = b.hash
      LIMIT 1
    ) IS NULL`;
}

/**
 * Delete the workspace's blobs that no `fs_entries` row of any version
 * references and whose `created_at` is older than `minAgeMs`. Their
 * `fs_blob_chunks` rows go by FK cascade; `fs_chunk_embeddings` (keyed by
 * chunk content hash, no FK) keeps its own lifetime.
 *
 * Safe beside concurrent writes. Every write transaction holds the blob guard
 * (`internals/blob-guard.ts`) shared from its first statement to commit. Per
 * batch:
 *   1. candidates, without any lock: up to `batchSize` unreferenced,
 *      old-enough hashes, keyset by hash;
 *   2. a transaction that takes the guard exclusive with
 *      `pg_try_advisory_xact_lock`, which succeeds only while no write
 *      transaction in the workspace is open. It never queues, so writers never
 *      wait behind a collector that is waiting; on failure it backs off and
 *      retries until `lockTimeoutMs`;
 *   3. in a new statement (a snapshot that sees every committed write):
 *      DELETE the candidates still unreferenced and still old enough.
 * Writers that arrive during step 3 wait for that one DELETE. Cost per batch
 * does not depend on the number of versions.
 *
 * Writers on bash-gres 3.2 or earlier do not take the guard: upgrade every
 * process that writes to the workspace before the first call.
 */
export const collectOrphanBlobs = op(async function collectOrphanBlobs<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  opts: CollectOrphanBlobsOptions,
): Promise<CollectOrphanBlobsResult> {
  const minAgeMs = opts?.minAgeMs;
  if (typeof minAgeMs !== "number" || !Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new Error("collectOrphanBlobs: minAgeMs must be a non-negative number");
  }
  const batchSize = Math.min(
    Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE)),
    MAX_BATCH_SIZE,
  );
  const lockTimeoutMs = Math.max(0, opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  if (ctx.inTransaction || (await insideCallerTransaction(ctx))) {
    // In a caller's transaction the exclusive lock would last until that
    // transaction commits (stalling every writer meanwhile), and a
    // REPEATABLE READ snapshot could miss references.
    throw new Error(
      "collectOrphanBlobs: cannot run inside a transaction (fs.transaction() or a handle built on one)",
    );
  }

  const result: CollectOrphanBlobsResult = {
    blobs: 0,
    bytes: 0,
    complete: true,
    batches: 0,
    pending: 0,
  };
  let after: Uint8Array = new Uint8Array(0);

  for (;;) {
    const found = await ctx.withReadOnlyWorkspace((tx) =>
      tx.query<{ hash: Uint8Array }>(
        `SELECT b.hash FROM fs_blobs b
         WHERE b.workspace_id = $1
           AND b.hash > $2::bytea
           AND ${orphanSql("$3")}
         ORDER BY b.hash
         LIMIT $4`,
        [ctx.workspaceId, after, minAgeMs, batchSize],
      ),
    );
    const hashes = found.rows.map((r) => r.hash);
    if (hashes.length === 0) return result;
    after = hashes[hashes.length - 1]!;

    const deleted = await deleteLocked(ctx, hashes, minAgeMs, lockTimeoutMs);
    if (deleted === null) {
      result.complete = false;
      result.pending = await countPending(ctx, minAgeMs);
      return result;
    }
    result.batches++;
    result.blobs += deleted.blobs;
    result.bytes += deleted.bytes;
    if (hashes.length < batchSize) return result;
  }
});

/** One locked batch; `null` when the guard stayed held past the timeout. */
async function deleteLocked<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  hashes: Uint8Array[],
  minAgeMs: number,
  lockTimeoutMs: number,
): Promise<{ blobs: number; bytes: number } | null> {
  const deadline = Date.now() + lockTimeoutMs;
  let backoff = BACKOFF_START_MS;
  for (;;) {
    const out = await ctx.withWorkspaceUnguarded(async (tx) => {
      if (!(await tryExclusiveBlobGuard(tx, ctx.workspaceId))) return null;
      // A new statement: its snapshot is taken with the guard held, so it
      // sees every write transaction that could reference these blobs.
      const r = await tx.query<{ n: number | string; bytes: number | string }>(
        `WITH deleted AS (
           DELETE FROM fs_blobs b
           WHERE b.workspace_id = $1
             -- An uncorrelated ARRAY(...) runs once (InitPlan), so this stays
             -- an index condition on fs_blobs_pkey (see delete-version-by-id).
             AND b.hash = ANY(
               ARRAY(SELECT decode(h, 'hex') FROM unnest($2::text[]) AS h)
             )
             AND ${orphanSql("$3")}
           RETURNING b.size_bytes
         )
         SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM deleted`,
        [ctx.workspaceId, hashes.map(bytesKey), minAgeMs],
      );
      return {
        blobs: Number(r.rows[0]?.n ?? 0),
        bytes: Number(r.rows[0]?.bytes ?? 0),
      };
    });
    if (out !== null) return out;
    if (Date.now() + backoff > deadline) return null;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

async function countPending<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  minAgeMs: number,
): Promise<number> {
  const r = await ctx.withReadOnlyWorkspace((tx) =>
    tx.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM fs_blobs b
       WHERE b.workspace_id = $1
         AND ${orphanSql("$2")}`,
      [ctx.workspaceId, minAgeMs],
    ),
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Whether the handle's client runs inside a transaction someone else opened
 * (a handle built on a Drizzle transaction, say). A transaction-local setting
 * outlives its statement only inside an open transaction; outside one, each
 * statement commits on its own and the setting is gone by the second.
 */
async function insideCallerTransaction<TFs>(
  ctx: FilesystemOpsContext<TFs>,
): Promise<boolean> {
  await ctx.withReadOnlyWorkspace((tx) =>
    tx.query(`SELECT set_config('bash_gres.collector_probe', 'open', true)`),
  );
  const r = await ctx.withReadOnlyWorkspace((tx) =>
    tx.query<{ v: string | null }>(
      `SELECT current_setting('bash_gres.collector_probe', true) AS v`,
    ),
  );
  if (r.rows[0]?.v !== "open") return false;
  await ctx.withReadOnlyWorkspace((tx) =>
    tx.query(`SELECT set_config('bash_gres.collector_probe', '', true)`),
  );
  return true;
}
