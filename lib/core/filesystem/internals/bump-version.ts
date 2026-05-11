import type { SqlClient } from "../../types.js";

/**
 * Bump `fs_versions.last_write_at = now()` for a given version inside an
 * existing transaction. Call once at the end of any write operation that
 * mutates `fs_entries` so reads can answer "when did this version last
 * change" in O(1).
 *
 * Cost: a single-row PK UPDATE with HOT-eligible payload. ~100µs of DB time
 * plus one round-trip; negligible against the rest of the write transaction.
 *
 * Skip the standalone call (and emit the bump as a CTE in the existing
 * statement) only on the txless fast path — see `bumpLastWriteAtCte`.
 */
export async function bumpLastWriteAt(
  tx: SqlClient,
  workspaceId: string,
  versionId: number,
): Promise<void> {
  await tx.query(
    `UPDATE fs_versions SET last_write_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, versionId],
  );
}

/**
 * CTE fragment for cases where a write op is a single SQL statement and we
 * don't want a second round-trip (e.g., `tryFastWriteFile`). The caller is
 * responsible for placing the fragment in their `WITH` chain and reusing
 * the same `$workspaceIdParam` / `$versionIdParam` indices already in their
 * statement.
 *
 * `gateCte`, if supplied, names a CTE that must be non-empty for the bump
 * to apply (e.g., the validation CTE produces one row only when status =
 * 'ok'). When omitted, the bump runs unconditionally.
 */
export function bumpLastWriteAtCte(opts: {
  workspaceIdParam: number;
  versionIdParam: number;
  gateCte?: string;
}): string {
  const where = opts.gateCte
    ? `AND EXISTS (SELECT 1 FROM ${opts.gateCte})`
    : "";
  return `version_bump AS (
    UPDATE fs_versions SET last_write_at = now()
    WHERE workspace_id = $${opts.workspaceIdParam}
      AND id = $${opts.versionIdParam}
      ${where}
    RETURNING 1
  )`;
}
