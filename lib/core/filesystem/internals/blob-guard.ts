import type { SqlClient } from "../../types.js";

/**
 * The blob guard: a per-workspace advisory lock,
 * `(hashtext(workspace_id), BLOB_GUARD_LOCK_KEY)`, that keeps blob deletion
 * away from transactions that may still reference a blob.
 *
 * Every write transaction holds it shared from its first statement until
 * commit (`runInWorkspace`, and the one-statement fast paths inside their
 * `_ws` CTE, via `blobGuardFrom`). Deleting blobs takes it exclusive with a
 * try-lock (`tryExclusiveBlobGuard`), which succeeds only while no other
 * write transaction in the workspace is open, so a later statement's
 * snapshot sees every entry that could reference the blobs it deletes.
 *
 * -1 is the workspace byte quota lock; version locks use the (positive)
 * version id.
 */
export const BLOB_GUARD_LOCK_KEY = -2;

/** The shared guard as a FROM item; `wsParam` is the workspace id param. */
export function blobGuardFrom(wsParam: string): string {
  return `(SELECT pg_advisory_xact_lock_shared(hashtext(${wsParam}), ${BLOB_GUARD_LOCK_KEY})) AS blob_guard`;
}

/**
 * Take the guard exclusive for the rest of `tx`, without waiting: `false`
 * when another transaction holds it. The transaction's own shared hold does
 * not conflict, so a write transaction can call it before deleting blobs.
 */
export async function tryExclusiveBlobGuard(
  tx: SqlClient,
  workspaceId: string,
): Promise<boolean> {
  const r = await tx.query<{ got: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1), ${BLOB_GUARD_LOCK_KEY}) AS got`,
    [workspaceId],
  );
  return r.rows[0]?.got === true;
}
