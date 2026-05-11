import type {
  SqlClient,
  VersionDiffEntry,
  VersionDiffOptions,
} from "../../types.js";
import { pathToLtree, normalizePath } from "../../path-encoding.js";
import { op, type FilesystemOpsContext } from "./context.js";
import { fetchVersionChanges } from "./fetch-version-changes.js";

interface VersionRow {
  parent_version_id: number | string | null;
}

/**
 * Compute the diff for a single history entry, by numeric `versionId` as
 * returned by `listHistory()`. Diffs the version against its parent (or
 * against an empty tree when `parentVersionId IS NULL`).
 *
 * Unlike `diff(label)`, this bypasses the label resolver, so it works for
 * deleted-but-retained versions and for the root entry. Optionally scope to
 * a subtree with `opts.path`.
 *
 * `before` is the parent's entry; `after` is the version's entry — i.e.
 * "what changed when this version was created".
 */
export const versionDiff = op(async (
  ctx,
  versionId: number,
  opts?: VersionDiffOptions,
): Promise<VersionDiffEntry[]> => {
  if (!Number.isInteger(versionId) || versionId <= 0) {
    throw new Error("versionDiff: versionId must be a positive integer");
  }
  const scopeUser = opts?.path ? normalizePath(opts.path) : "/";
  ctx.guardRead(scopeUser);
  const internalScope = ctx.toInternalPath(scopeUser);

  return ctx.withReadOnlyWorkspace(async (tx) => {
    const scopeLtree = pathToLtree(internalScope, ctx.workspaceId);
    const parentVersionId = await resolveParentVersionId(ctx, tx, versionId);
    const { entries } = await fetchVersionChanges(
      ctx,
      tx,
      versionId,
      parentVersionId,
      scopeLtree,
      null,
      false,
      opts?.includeContent ?? false,
    );
    return entries;
  });
});

export async function resolveParentVersionId<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
): Promise<number | null> {
  const versionRootId = await ctx.getVersionRootId(tx);
  const r = await tx.query<VersionRow>(
    `SELECT parent_version_id FROM fs_versions
      WHERE workspace_id = $1 AND version_root_id = $2 AND id = $3
      LIMIT 1`,
    [ctx.workspaceId, versionRootId, versionId],
  );
  if (r.rows.length === 0) {
    throw new Error(
      `versionDiff: version id ${versionId} not found in this version root`,
    );
  }
  const parent = r.rows[0]!.parent_version_id;
  return parent === null ? null : Number(parent);
}
