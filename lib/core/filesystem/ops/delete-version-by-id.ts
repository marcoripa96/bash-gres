import type { SqlClient } from "../../types.js";
import { bytesKey } from "../internals/hashes.js";
import { op, type FilesystemOpsContext } from "./context.js";

export const deleteVersionById = op(async (
  ctx,
  tx: SqlClient,
  versionId: number,
  retention?: "retain" | "discard",
): Promise<void> => {
    if ((retention ?? ctx.historyRetention) === "discard") {
      await hardDeleteVersionById(ctx, tx, versionId);
      return;
    }

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

async function hardDeleteVersionById<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<void> {
  const children = await tx.query(
    `SELECT 1 FROM fs_versions
     WHERE workspace_id = $1 AND version_root_id = $3 AND parent_version_id = $2
     LIMIT 1`,
    [ctx.workspaceId, versionId, await ctx.getVersionRootId(tx)],
  );
  if (children.rows.length > 0) {
    throw new Error(
      `deleteVersion: version has descendants; delete or squash them first`,
    );
  }

  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext($1), $2::int)`,
    [ctx.workspaceId, versionId],
  );

  const freed = await tx.query<{ blob_hash: Uint8Array }>(
    `DELETE FROM fs_entries
     WHERE workspace_id = $1 AND version_id = $2
     RETURNING blob_hash`,
    [ctx.workspaceId, versionId],
  );
  const candidates = new Map<string, Uint8Array>();
  for (const row of freed.rows) {
    if (row.blob_hash) {
      candidates.set(bytesKey(row.blob_hash), row.blob_hash);
    }
  }

  await tx.query(
    `DELETE FROM version_ancestors
     WHERE workspace_id = $1 AND (descendant_id = $2 OR ancestor_id = $2)`,
    [ctx.workspaceId, versionId],
  );
  await tx.query(
    `DELETE FROM fs_versions
     WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, versionId],
  );

  if (candidates.size === 0) return;
  // Map keys are the hashes' hex encoding (`bytesKey`).
  const hexHashes = [...candidates.keys()];
  const CHUNK_SIZE = 8000;
  for (let start = 0; start < hexHashes.length; start += CHUNK_SIZE) {
    const chunk = hexHashes.slice(start, start + CHUNK_SIZE);
    // Both lookups are written so the plan can't depend on statistics. A
    // freshly written workspace is estimated at ~1 row, and a join form
    // (VALUES + NOT EXISTS) then degrades to rescanning the whole workspace
    // per candidate: 1000 candidates took ~1.4 s instead of ~6 ms. The
    // uncorrelated ARRAY(...) runs once as an InitPlan, so `hash = ANY(...)`
    // stays an index condition on fs_blobs_pkey; the scalar subquery is never
    // pulled up into a join, so each candidate gets one (workspace_id,
    // blob_hash) probe that stops at the first reference. One text[] param
    // keeps the statement text fixed, so a prepared-statement client caches
    // one statement instead of one per candidate count.
    await tx.query(
      `DELETE FROM fs_blobs b
       WHERE b.workspace_id = $1
         AND b.hash = ANY(
           ARRAY(SELECT decode(h, 'hex') FROM unnest($2::text[]) AS h)
         )
         AND (
           SELECT 1 FROM fs_entries
           WHERE workspace_id = $1 AND blob_hash = b.hash
           LIMIT 1
         ) IS NULL`,
      [ctx.workspaceId, chunk],
    );
  }
}
