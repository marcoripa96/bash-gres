import type {
  DirentEntry,
  DirentStatEntry,
  FsStat,
  NodeType,
  SqlClient,
  SqlParam,
  WalkEntry,
} from "../../types.js";
import { FsError } from "../../types.js";
import {
  fileName,
  ltreeFileName,
  ltreeToPath,
  normalizePath,
  parentPath,
  pathToLtree,
} from "../../path-encoding.js";
import { isExcluded } from "../../exclude.js";
import { mountVisible } from "../../mounts.js";
import { TOMBSTONE } from "../internals/constants.js";
import type { InternalEntryShape } from "../internals/entry-shapes.js";
import type { BlobRow, DirChildRow, EntryRow, SubtreeRow } from "../internals/rows.js";
import { FsVersionBase } from "./version.js";

export class FsVisibilityBase extends FsVersionBase {
  protected async resolveEntry(
    tx: SqlClient,
    posixPath: string,
  ): Promise<EntryRow | null> {
    if (!this.excludes.empty && isExcluded(this.excludes, posixPath)) {
      return null;
    }
    if (!this.mounts.empty && !mountVisible(this.mounts, posixPath)) {
      return null;
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(posixPath, this.workspaceId);
    // Flip: select entries at this exact path first (typically 1 row), then
    // join to the descendant's ancestor closure to pick the nearest ancestor
    // that owns it. The lateral form probes once per ancestor (O(chain_depth)
    // GiST lookups); this form does a single path lookup plus an ordered
    // closure scan with a cheap join filter, regardless of chain depth.
    //
    // The CTE is `MATERIALIZED` deliberately: under prepared-statement plan
    // caching, postgres switches to a generic plan after ~5 executions, and
    // its generic costing for the un-fenced shape inverts the join order
    // (drives from ancestors, probes the path GiST 51× per read at depth 50).
    // Materializing the path lookup keeps it as the build side of the join.
    const r = await tx.query<EntryRow>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, mode, size_bytes, mtime, created_at
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $2::ltree
       )
       SELECT e.workspace_id, e.version_id, e.path::text AS path, e.blob_hash,
              e.node_type, e.symlink_target, e.mode, e.size_bytes, e.mtime, e.created_at
       FROM e
       JOIN version_ancestors a
         ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
       WHERE a.descendant_id = $3
       ORDER BY a.depth ASC
       LIMIT 1`,
      [this.workspaceId, lt, versionId],
    );
    const row = r.rows[0];
    if (!row || row.node_type === TOMBSTONE) return null;
    return row;
  }

  /**
   * Visibility lookup for many paths in a single round-trip. Mirrors
   * `resolveEntry` but unrolls over an array of requested paths, evaluates
   * each one's nearest-ancestor row independently, and returns a Map keyed
   * by the original input path. Lets hot write paths fold parent-existence
   * + existing-entry checks into one query.
   *
   * Single-path callers should keep using `resolveEntry`: the planner
   * picks a tighter plan for a literal `path = $n::ltree` predicate than
   * for `path = req.p` over `unnest`, and we don't want to regress reads
   * for the savings on writes.
   */
  protected async resolveEntries(
    tx: SqlClient,
    posixPaths: string[],
  ): Promise<Map<string, EntryRow | null>> {
    const out = new Map<string, EntryRow | null>();
    const lookups: { posix: string; lt: string }[] = [];
    for (const posix of posixPaths) {
      if (out.has(posix)) continue;
      if (!this.excludes.empty && isExcluded(this.excludes, posix)) {
        out.set(posix, null);
        continue;
      }
      if (!this.mounts.empty && !mountVisible(this.mounts, posix)) {
        out.set(posix, null);
        continue;
      }
      lookups.push({ posix, lt: pathToLtree(posix, this.workspaceId) });
      out.set(posix, null);
    }
    if (lookups.length === 0) return out;
    if (lookups.length === 1) {
      // Single path: defer to the indexed direct-equality plan.
      const only = lookups[0]!;
      const row = await this.resolveEntry(tx, only.posix);
      if (row) out.set(only.posix, row);
      return out;
    }

    const versionId = await this.getCurrentVersionId(tx);
    const ltArray = lookups.map((l) => l.lt);
    // DISTINCT ON (path) over an ordered scan picks the nearest-ancestor row
    // per requested path. Same flip and same MATERIALIZED fence as
    // resolveEntry — keep the path lookup as the build side of the join even
    // under generic plan caching.
    const r = await tx.query<EntryRow>(
      `WITH e AS MATERIALIZED (
         SELECT workspace_id, version_id, path, blob_hash, node_type,
                symlink_target, mode, size_bytes, mtime, created_at
         FROM fs_entries
         WHERE workspace_id = $1 AND path = ANY($2::ltree[])
       )
       SELECT DISTINCT ON (e.path)
              e.workspace_id, e.version_id, e.path::text AS path, e.blob_hash,
              e.node_type, e.symlink_target, e.mode, e.size_bytes, e.mtime, e.created_at
       FROM e
       JOIN version_ancestors a
         ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
       WHERE a.descendant_id = $3
       ORDER BY e.path, a.depth ASC`,
      [this.workspaceId, ltArray, versionId],
    );
    const ltToPosix = new Map<string, string>();
    for (const l of lookups) ltToPosix.set(l.lt, l.posix);
    for (const row of r.rows) {
      if (row.node_type === TOMBSTONE) continue;
      const posix = ltToPosix.get(row.path);
      if (posix !== undefined) out.set(posix, row);
    }
    return out;
  }

  protected async resolveEntryFollowSymlink(
    tx: SqlClient,
    posixPath: string,
    maxDepth: number = this.maxSymlinkDepth,
  ): Promise<EntryRow> {
    const node = await this.resolveEntry(tx, posixPath);
    if (!node)
      throw new FsError("ENOENT", "no such file or directory", posixPath);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError(
          "ELOOP",
          "too many levels of symbolic links",
          posixPath,
        );
      return this.resolveEntryFollowSymlink(
        tx,
        this.resolveLinkTargetPath(posixPath, node.symlink_target),
        maxDepth - 1,
      );
    }
    return node;
  }

  protected async getBlob(
    tx: SqlClient,
    hash: Uint8Array,
  ): Promise<BlobRow | null> {
    const r = await tx.query<BlobRow>(
      `SELECT hash, content, binary_data, size_bytes
       FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    return r.rows[0] ?? null;
  }

  // -- Visible directory listing ---------------------------------------------

  protected async listVisibleChildren(
    tx: SqlClient,
    parentPosix: string,
  ): Promise<DirChildRow[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(parentPosix, this.workspaceId);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<DirChildRow>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes,
           e.mtime
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND e.path != $3::ltree
           AND nlevel(e.path) = nlevel($3::ltree) + 1
           AND ${exc.sql}
           AND ${mnt.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT * FROM visible WHERE node_type != $4 ORDER BY path`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    return r.rows;
  }

  protected async listVisibleChildNames(
    tx: SqlClient,
    parentPosix: string,
  ): Promise<string[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(parentPosix, this.workspaceId);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<{ path: string; node_type: string }>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND e.path != $3::ltree
           AND nlevel(e.path) = nlevel($3::ltree) + 1
           AND ${exc.sql}
           AND ${mnt.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT path, node_type FROM visible WHERE node_type != $4 ORDER BY path`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    return r.rows.map((row) => ltreeFileName(row.path));
  }

  /**
   * Fetch every visible (non-tombstone) entry under `scopeLtree` for
   * `versionId`, keyed by internal POSIX path. Used by batch primitives
   * (merge/cherryPick/revert) to do classification entirely in TypeScript
   * once each side's tree is in memory.
   */
  protected async fetchVisibleEntryMap(
    tx: SqlClient,
    versionId: number,
    scopeLtree: string,
  ): Promise<Map<string, InternalEntryShape>> {
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      scopeLtree,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<{
      path: string;
      node_type: string;
      blob_hash: Uint8Array | null;
      symlink_target: string | null;
      mode: number;
      size_bytes: number | string;
      mtime: Date;
    }>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes,
           e.mtime
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
          WHERE e.workspace_id = $1
            AND a.descendant_id = $2
            AND e.path <@ $3::ltree
            AND ${exc.sql}
            AND ${mnt.sql}
          ORDER BY e.path, a.depth ASC
        )
        SELECT path, node_type, blob_hash, symlink_target, mode, size_bytes, mtime
        FROM visible WHERE node_type != $4`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    const map = new Map<string, InternalEntryShape>();
    for (const row of r.rows) {
      map.set(ltreeToPath(row.path), {
        type: row.node_type as NodeType,
        blobHash: row.blob_hash,
        symlinkTarget: row.symlink_target,
        mode: row.mode,
        sizeBytes: Number(row.size_bytes),
        mtime: new Date(row.mtime),
      });
    }
    return map;
  }

  protected async listVisibleSubtree(
    tx: SqlClient,
    rootPosix: string,
    includeRoot = false,
  ): Promise<SubtreeRow[]> {
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const filter = includeRoot ? "" : "AND e.path != $3::ltree";
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<SubtreeRow>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path::text AS path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes,
           e.mtime,
           nlevel(e.path) - nlevel($3::ltree) AS depth_in_subtree
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           ${filter}
           AND ${exc.sql}
           AND ${mnt.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT * FROM visible WHERE node_type != $4 ORDER BY path`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    return r.rows;
  }

  // -- Symlink target resolution ---------------------------------------------

  protected resolveLinkTargetPath(linkPath: string, target: string): string {
    let resolved: string;
    if (target.startsWith("/")) {
      resolved = normalizePath(this.rootDir + "/" + target);
    } else {
      resolved = normalizePath(parentPath(linkPath) + "/" + target);
    }
    this.guardRootBoundary(resolved);
    return resolved;
  }


  // -- Mappers ---------------------------------------------------------------

  protected mapDirChildToDirent(row: DirChildRow): DirentEntry {
    return {
      name: ltreeFileName(row.path),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
    };
  }

  protected mapDirChildToStatEntry(row: DirChildRow): DirentStatEntry {
    return {
      name: ltreeFileName(row.path),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
      symlinkTarget: row.symlink_target,
    };
  }

  protected mapSubtreeToWalk(row: SubtreeRow): WalkEntry {
    const userPath = ltreeToPath(row.path);
    return {
      path: this.toUserPath(userPath),
      name: fileName(userPath),
      depth: Number(row.depth_in_subtree),
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
      symlinkTarget: row.symlink_target,
    };
  }

  protected statFromEntry(row: EntryRow): FsStat {
    return {
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
    };
  }
}
