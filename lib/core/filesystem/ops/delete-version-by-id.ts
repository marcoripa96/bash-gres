import type { SqlClient } from "../../types.js";
import { bytesKey } from "../internals/hashes.js";
import { op } from "./context.js";

export const deleteVersionById = op(async (
  ctx,
  tx: SqlClient,
  versionId: number,
): Promise<void> => {
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

    // Advisory lock to serialize against concurrent writers of the same blobs
    // in this workspace. The lock is released at end of transaction.
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), $2::int)`,
      [ctx.workspaceId, versionId],
    );

    // Capture blob hashes that this version's entries referenced.
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

    if (candidates.size > 0) {
      // GC orphan blobs: only those previously owned by this version and now unreferenced.
      for (const hash of candidates.values()) {
        await tx.query(
          `DELETE FROM fs_blobs
           WHERE workspace_id = $1 AND hash = $2
             AND NOT EXISTS (
               SELECT 1 FROM fs_entries
               WHERE workspace_id = $1 AND blob_hash = $2
             )`,
          [ctx.workspaceId, hash],
        );
      }
    }
  });
