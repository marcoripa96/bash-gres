import type {
  SqlClient,
  VersionDiffEntry,
  VersionDiffOptions,
} from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import { op, type FilesystemOpsContext } from "./context.js";
import { fetchDiff } from "./fetch-diff.js";

interface IdRow {
  id: number | string;
}

/**
 * Compare the visible trees of two versions of this version root, both
 * addressed by numeric `versionId` as returned by `listHistory()`.
 *
 * `before` is `from`'s entry; `after` is `to`'s — reading "what changes if
 * `from` became `to`?" gives the natural interpretation. Like
 * `versionDiff(versionId)` this bypasses the label resolver, so either side
 * may be a deleted-but-retained version (e.g. one displaced by
 * `promoteTo(label, { dropPrevious: true })` under
 * `historyRetention: "retain"`); unlike it, the pair is unrestricted — any
 * two versions compare, adjacent or not, related or not. Equality is over
 * `node_type`, `blob_hash`, `mode`, and `symlink_target`; `mtime`,
 * `size_bytes`, and `created_at` are not part of the comparison.
 *
 * If `opts.path` is provided, the comparison is scoped to that user path
 * and its descendants. Tombstones in either version present as `null` for
 * that side.
 */
export const diffVersions = op(async (
  ctx,
  from: number,
  to: number,
  opts?: VersionDiffOptions,
): Promise<VersionDiffEntry[]> => {
    for (const [name, id] of [["from", from], ["to", to]] as const) {
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`diffVersions: ${name} must be a positive integer`);
      }
    }
    const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
    ctx.guardRead(scopeUser);
    const internalScope = ctx.toInternalPath(scopeUser);

    return ctx.withReadOnlyWorkspace(async (tx) => {
      await requireVersionsInRoot(ctx, tx, [from, to]);
      const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
      const { entries } = await fetchDiff(
        ctx,
        tx,
        from,
        to,
        scopeLtree,
        null,
        opts?.includeContent ?? false,
      );
      return entries;
    });
  });

async function requireVersionsInRoot<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  ids: number[],
): Promise<void> {
  const versionRootId = await ctx.getVersionRootId(tx);
  const r = await tx.query<IdRow>(
    `SELECT id FROM fs_versions
      WHERE workspace_id = $1 AND version_root_id = $2 AND id = ANY($3::bigint[])`,
    [ctx.workspaceId, versionRootId, ids],
  );
  const found = new Set(r.rows.map((row) => Number(row.id)));
  for (const id of ids) {
    if (!found.has(id)) {
      throw new Error(
        `diffVersions: version id ${id} not found in this version root`,
      );
    }
  }
}
