import type {
  SqlParam,
  VersionHistoryEntry,
  VersionHistoryOptions,
  VersionHistoryResult,
} from "../../types.js";
import { normalizePath, pathToLtree } from "../../path-encoding.js";
import { op } from "./context.js";
import { fetchPageChanges } from "./fetch-page-changes.js";

interface HistoryVersionRow {
  id: number | string;
  depth: number | string;
  label: string;
  parent_version_id: number | string | null;
  parent_label: string | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
  frozen_at: Date | string | null;
  merged_from: Array<number | string> | null;
}

export const listHistory = op(async (
  ctx,
  opts?: VersionHistoryOptions,
): Promise<VersionHistoryResult> => {
  const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
  ctx.guardRead(scopeUser);
  const internalScope = ctx.toInternalPath(scopeUser);
  const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
  const cursor = decodeCursor(opts?.cursor);
  const includeRoot = opts?.includeRoot ?? true;
  const changesMode: false | "paths" | true = opts?.includeChanges ?? false;

  return ctx.withReadOnlyWorkspace(async (tx) => {
    const versionRootId = await ctx.getVersionRootId(tx);
    const currentId = await ctx.getCurrentVersionId(tx);
    // Walk parent_version_id (not the ancestor closure, which
    // materialize()/compactHistory() trim) from the current version, or from
    // the cursor's version when the cursor names one.
    const startId = cursor?.id ?? currentId;
    const startDepth = cursor?.id !== undefined ? cursor.depth : 0;
    const minDepth = cursor === null ? 0 : cursor.depth + 1;
    const maxDepth = minDepth + limit; // one row past the page
    const params: SqlParam[] = [
      ctx.workspaceId,
      startId,
      versionRootId,
      startDepth,
      minDepth,
      maxDepth,
    ];

    const versions = await tx.query<HistoryVersionRow>(
      `WITH RECURSIVE chain(id, depth) AS (
         SELECT $2::bigint, $4::int
         UNION ALL
         SELECT v.parent_version_id, c.depth + 1
         FROM chain c
         JOIN fs_versions v
           ON v.workspace_id = $1
          AND v.id = c.id
         WHERE v.parent_version_id IS NOT NULL
           AND c.depth < $6
       )
       SELECT
         v.id,
         c.depth,
         v.label,
         v.parent_version_id,
         p.label AS parent_label,
         v.created_at,
         v.deleted_at,
         v.frozen_at,
         ARRAY(
           SELECT m.source_id FROM fs_version_merges m
           WHERE m.workspace_id = v.workspace_id AND m.version_id = v.id
           ORDER BY m.source_id
         ) AS merged_from
       FROM chain c
       JOIN fs_versions v
         ON v.workspace_id = $1
        AND v.id = c.id
       LEFT JOIN fs_versions p
         ON p.workspace_id = v.workspace_id
        AND p.id = v.parent_version_id
       WHERE v.version_root_id = $3
         AND c.depth >= $5
       ORDER BY c.depth ASC`,
      params,
    );

    const pageRows = versions.rows.slice(0, limit);
    const visibleRows = includeRoot
      ? pageRows
      : pageRows.filter((row) => row.parent_version_id !== null);

    const changesByVersion =
      changesMode === false || visibleRows.length === 0
        ? new Map<number, []>()
        : await fetchPageChanges(
            ctx,
            tx,
            visibleRows.map((row) => Number(row.id)),
            scopeLtree,
            changesMode === "paths",
          );

    const entries: VersionHistoryEntry[] = visibleRows.map((row) => {
      const versionId = Number(row.id);
      const parentVersionId =
        row.parent_version_id === null ? null : Number(row.parent_version_id);
      return {
        versionId,
        version: row.label,
        parentVersionId,
        parentVersion: row.parent_label,
        createdAt: new Date(row.created_at),
        deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
        frozenAt: row.frozen_at === null ? null : new Date(row.frozen_at),
        mergedFrom: (row.merged_from ?? []).map(Number),
        changes: changesByVersion.get(versionId) ?? [],
      };
    });
    const last = pageRows[pageRows.length - 1];
    return {
      entries,
      nextCursor:
        versions.rows.length > limit && last
          ? encodeCursor(Number(last.depth), Number(last.id))
          : null,
    };
  });
});

function encodeCursor(depth: number, id: number): string {
  return Buffer.from(JSON.stringify({ depth, id })).toString("base64url");
}

/**
 * `{ depth, id }`: the last row of the previous page, so the next page walks
 * on from `id`. Cursors without `id` (bash-gres < 3.2) walk from the current
 * version and skip `depth` rows.
 */
function decodeCursor(
  cursor: string | undefined,
): { depth: number; id?: number } | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "depth" in parsed) {
      const depth = parsed.depth;
      const id = "id" in parsed ? parsed.id : undefined;
      if (typeof depth === "number" && Number.isInteger(depth) && depth >= 0) {
        if (id === undefined) return { depth };
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
          return { depth, id };
        }
      }
    }
  } catch {
    // fall through
  }
  throw new Error("listHistory: invalid cursor");
}
