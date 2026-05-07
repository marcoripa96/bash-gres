import type { VersionedDirectoryOptions } from "../../types.js";
import { FsError } from "../../types.js";
import { pathToLtree } from "../../path-encoding.js";
import { DEFAULT_VERSION } from "../internals/constants.js";
import { op } from "./context.js";

export const versioned = op(async (
  ctx,
  path: string,
  options?: VersionedDirectoryOptions,
) => {
    const internal = ctx.guardRead(path);
    const version = options?.version ?? DEFAULT_VERSION;
    if (version.length === 0) {
      throw new Error("versioned: version must be a non-empty string");
    }

    let versionRootId: number;
    await ctx.withWorkspace(async (tx) => {
      const rootLtree = pathToLtree(internal, ctx.workspaceId);
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM fs_version_roots
         WHERE workspace_id = $1 AND path = $2::ltree
         LIMIT 1`,
        [ctx.workspaceId, rootLtree],
      );
      if (r.rows.length === 0) {
        throw new FsError(
          "ENOTVERSIONED",
          "not a versioned directory",
          path,
        );
      }
      versionRootId = Number(r.rows[0]!.id);
    });

    return ctx.createVersionedFilesystem(internal, version, versionRootId!);
  });
