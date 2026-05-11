import type { SqlClient } from "../../types.js";
import { op } from "./context.js";

export const deleteVersionById = op(async (
  ctx,
  tx: SqlClient,
  versionId: number,
): Promise<void> => {
    // Deleting a version is git-like branch deletion: hide the label from the
    // active namespace but keep the commit rows and ancestor links for history.
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), $2::int)`,
      [ctx.workspaceId, versionId],
    );
    await tx.query(
      `UPDATE fs_versions
       SET deleted_at = COALESCE(deleted_at, now())
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, versionId],
    );
  });
