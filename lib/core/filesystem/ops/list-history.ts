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
    const params: SqlParam[] = [ctx.workspaceId, currentId, versionRootId];
    let cursorClause = "";
    if (cursor !== null) {
      params.push(cursor.depth);
      cursorClause = `AND a.depth > $${params.length}`;
    }
    params.push(limit + 1);

    const versions = await tx.query<HistoryVersionRow>(
      `SELECT
         v.id,
         a.depth,
         v.label,
         v.parent_version_id,
         p.label AS parent_label,
         v.created_at,
         v.deleted_at
       FROM version_ancestors a
       JOIN fs_versions v
         ON v.workspace_id = a.workspace_id
        AND v.id = a.ancestor_id
       LEFT JOIN fs_versions p
         ON p.workspace_id = v.workspace_id
        AND p.id = v.parent_version_id
        WHERE a.workspace_id = $1
          AND a.descendant_id = $2
          AND v.version_root_id = $3
          ${cursorClause}
        ORDER BY a.depth ASC
        LIMIT $${params.length}`,
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
        changes: changesByVersion.get(versionId) ?? [],
      };
    });
    const last = pageRows[pageRows.length - 1];
    return {
      entries,
      nextCursor:
        versions.rows.length > limit && last ? encodeCursor(Number(last.depth)) : null,
    };
  });
});

function encodeCursor(depth: number): string {
  return Buffer.from(JSON.stringify({ depth })).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { depth: number } | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "depth" in parsed) {
      const depth = parsed.depth;
      if (typeof depth === "number" && Number.isInteger(depth) && depth >= 0) {
        return { depth };
      }
    }
  } catch {
    // fall through
  }
  throw new Error("listHistory: invalid cursor");
}
