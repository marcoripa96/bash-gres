import type { SqlClient, SqlParam } from "../../types.js";
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
      const hashes = [...candidates.values()];
      const CHUNK_SIZE = 8000;
      for (let start = 0; start < hashes.length; start += CHUNK_SIZE) {
        const chunk = hashes.slice(start, start + CHUNK_SIZE);
        const params: SqlParam[] = [ctx.workspaceId, ...chunk];
        const values = chunk
          .map((_, i) => `($${i + 2}::bytea)`)
          .join(", ");
        await tx.query(
          `WITH candidates(hash) AS (VALUES ${values})
           DELETE FROM fs_blobs b
           USING candidates c
           WHERE b.workspace_id = $1
             AND b.hash = c.hash
             AND NOT EXISTS (
                SELECT 1 FROM fs_entries
                WHERE workspace_id = $1 AND blob_hash = c.hash
              )`,
          params,
        );
      }
    }
  });
