import type {
  DropWorkspaceOptions,
  DropWorkspaceResult,
  SqlClient,
} from "./types.js";
import { BLOB_GUARD_LOCK_KEY } from "./filesystem/internals/blob-guard.js";

const DEFAULT_DROP_STATEMENT_TIMEOUT_MS = 60_000;

/**
 * Delete everything bash-gres stores for `workspaceId`: every version root
 * (labelled or not, `/` included), every version (live, deleted-but-retained,
 * frozen, materialized), the ancestor closure, merge records, entries, blobs,
 * chunk rows and cached chunk embeddings. No retention setting keeps
 * anything. A workspace that does not exist (or was already dropped) returns
 * all-zero counts.
 *
 * Runs in a transaction on `db`: when `db` is already inside one (a Drizzle
 * transaction wrapped with `createDrizzleClient`, a postgres.js
 * `TransactionSql`, a node-postgres client in BEGIN) that is a savepoint, so
 * the drop commits or rolls back with the caller's transaction.
 *
 * Writers: the first thing it does is take the workspace's blob guard
 * exclusive, blocking (`pg_advisory_xact_lock`). Every write transaction
 * holds the guard shared from its first statement, before it reads or locks
 * any row, so the drop waits for the open ones to commit and the ones that
 * start later wait behind it, holding nothing. The drop takes no row lock
 * before the guard, so the wait cannot close a cycle. The guard is held
 * until the outermost transaction ends; a writer that was waiting then
 * finds its version row gone, writes nothing, and fails as on a workspace
 * never created. `collectOrphanBlobs` only try-locks the guard, so it backs
 * off while a drop runs.
 *
 * Inside a caller's transaction, call it before that transaction writes to
 * the workspace through a handle: row locks taken earlier in the same
 * transaction can make a writer that holds the guard wait on the caller
 * while the caller waits on it (Postgres then aborts one as a deadlock).
 *
 * RLS: it sets `app.workspace_id` to `workspaceId` (and `statement_timeout`)
 * for its own statements and puts back the values it found, so a role
 * subject to the `workspace_isolation` policy needs nothing set beforehand,
 * only SELECT and DELETE on the fs tables. Every statement also filters on
 * `workspace_id`. A transaction whose `app.workspace_id` is already set to a
 * different workspace is refused: a connection scoped to one tenant cannot
 * drop another.
 *
 * Needs READ COMMITTED: under REPEATABLE READ or SERIALIZABLE the snapshot
 * predates the wait for writers, so rows they committed meanwhile would
 * survive. It throws instead.
 */
export async function dropWorkspace(
  db: SqlClient,
  workspaceId: string,
  options: DropWorkspaceOptions = {},
): Promise<DropWorkspaceResult> {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("dropWorkspace: workspaceId must be a non-empty string");
  }
  const timeoutMs = options.statementTimeoutMs ?? DEFAULT_DROP_STATEMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("dropWorkspace: statementTimeoutMs must be a non-negative integer");
  }

  return db.transaction(async (tx) => {
    // The previous settings are read before they are replaced (OFFSET 0
    // keeps the subquery from being flattened into the same projection).
    const before = await tx.query<{
      ws: string | null;
      st: string;
      isolation: string;
      embeddings: boolean;
    }>(
      `SELECT p.ws, p.st, p.isolation, p.embeddings,
              set_config('app.workspace_id', $1, true),
              set_config('statement_timeout', $2, true)
       FROM (
         SELECT current_setting('app.workspace_id', true) AS ws,
                current_setting('statement_timeout') AS st,
                current_setting('transaction_isolation') AS isolation,
                to_regclass('fs_chunk_embeddings') IS NOT NULL AS embeddings
         OFFSET 0
       ) p`,
      [workspaceId, String(timeoutMs)],
    );
    const prev = before.rows[0]!;
    // A transaction already scoped to another workspace (a tenant-scoped
    // connection, or bash-gres handles of that workspace earlier in it) may
    // not reach a different tenant's rows through the drop.
    if (prev.ws !== null && prev.ws !== "" && prev.ws !== workspaceId) {
      throw new Error(
        `dropWorkspace: the transaction is scoped to another workspace (app.workspace_id = '${prev.ws}')`,
      );
    }
    if (prev.isolation !== "read committed") {
      throw new Error(
        `dropWorkspace: needs READ COMMITTED, the transaction is ${prev.isolation}`,
      );
    }

    // Before any row is read: see the doc comment.
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), ${BLOB_GUARD_LOCK_KEY})`,
      [workspaceId],
    );

    const del = async (table: string): Promise<number> => {
      const r = await tx.query<{ n: number | string }>(
        `WITH d AS (DELETE FROM ${table} WHERE workspace_id = $1 RETURNING 1)
         SELECT count(*) AS n FROM d`,
        [workspaceId],
      );
      return Number(r.rows[0]?.n ?? 0);
    };

    // Referencing rows first: chunks before blobs (FK), versions before
    // their roots (FK). One DELETE covers the parent_version_id chain.
    const chunkEmbeddings = prev.embeddings ? await del("fs_chunk_embeddings") : 0;
    const chunks = await del("fs_blob_chunks");
    const entries = await del("fs_entries");
    const versionMerges = await del("fs_version_merges");
    const versionAncestors = await del("version_ancestors");
    const versions = await del("fs_versions");
    const versionRoots = await del("fs_version_roots");
    const blobRows = await tx.query<{ n: number | string; bytes: number | string }>(
      `WITH d AS (DELETE FROM fs_blobs WHERE workspace_id = $1 RETURNING size_bytes)
       SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS bytes FROM d`,
      [workspaceId],
    );

    await tx.query(
      `SELECT set_config('app.workspace_id', $1, true),
              set_config('statement_timeout', $2, true)`,
      [prev.ws ?? "", prev.st],
    );

    return {
      versionRoots,
      versions,
      versionAncestors,
      versionMerges,
      entries,
      blobs: Number(blobRows.rows[0]?.n ?? 0),
      bytes: Number(blobRows.rows[0]?.bytes ?? 0),
      chunks,
      chunkEmbeddings,
    };
  });
}
