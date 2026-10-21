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
import { Coalescer } from "../internals/coalescer.js";
import { FsVersionBase } from "./version.js";

export class FsVisibilityBase extends FsVersionBase {
  /** Coalesces concurrent `lookupEntry` calls; see `Coalescer`. */
  private readonly lookups = new Coalescer<EntryRow>({
    one: (path) =>
      this.withReadOnlyWorkspace((tx) => this.resolveEntry(tx, path)),
    many: async (paths) => {
      const rows = await this.withReadOnlyWorkspace((tx) =>
        this.resolveEntries(tx, paths),
      );
      const found = new Map<string, EntryRow>();
      for (const [path, row] of rows) if (row) found.set(path, row);
      return found;
    },
    // Metadata rows are small; a `du` of a large tree still fits a few.
    maxBatch: 256,
    // A transaction's calls run on its own connection, one at a time.
    unbatched: () => this.txClient !== null,
  });

  /** True when excludes or mounts make `posixPath` invisible to reads. */
  protected isHiddenFromReads(posixPath: string): boolean {
    return (
      (!this.excludes.empty && isExcluded(this.excludes, posixPath)) ||
      (!this.mounts.empty && !mountVisible(this.mounts, posixPath))
    );
  }

  /**
   * `resolveEntry` for a public single-path read, with concurrent calls
   * answered by one `resolveEntries` query (a lone call still runs the
   * single-path query). Callers must reach this before their first `await`.
   * Inside `transaction()` lookups run directly against the open transaction.
   */
  protected lookupEntry(posixPath: string): Promise<EntryRow | null> {
    return this.lookups.load(posixPath);
  }

  protected async resolveEntry(
    tx: SqlClient,
    posixPath: string,
  ): Promise<EntryRow | null> {
    if (this.isHiddenFromReads(posixPath)) return null;
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
      if (this.isHiddenFromReads(posix)) {
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
    return this.followSymlinkFrom(posixPath, node, maxDepth, tx);
  }

  /**
   * The rest of `resolveEntryFollowSymlink` for a row already fetched at
   * `posixPath` (e.g. by a coalesced lookup): ENOENT when missing, else follow
   * symlinks up to `maxDepth`, against `tx` when given.
   */
  protected async followSymlinkFrom(
    posixPath: string,
    node: EntryRow | null,
    maxDepth: number,
    tx?: SqlClient,
  ): Promise<EntryRow> {
    if (!node)
      throw new FsError("ENOENT", "no such file or directory", posixPath);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError(
          "ELOOP",
          "too many levels of symbolic links",
          posixPath,
        );
      const target = this.resolveLinkTargetPath(posixPath, node.symlink_target);
      return tx
        ? this.resolveEntryFollowSymlink(tx, target, maxDepth - 1)
        : this.withReadOnlyWorkspace((t) =>
            this.resolveEntryFollowSymlink(t, target, maxDepth - 1),
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

  /**
   * `resolveEntryFollowSymlink(dir)` + the ENOTDIR check + the listing in one
   * round-trip: the directory's own nearest-ancestor row comes back first
   * (`self = 0`), the listing after, gated on that row being a directory.
   * `scope` picks the listing: `listVisibleChildren` (default; readdir*, so
   * every `ls`/`find`/`grep -r` level) or `listVisibleSubtree` without the
   * root ("subtree"; walk). A symlinked directory falls back to the
   * two-step path, which follows the link chain.
   */
  protected listDirectory(
    tx: SqlClient,
    dirPosix: string,
    userPath: string,
  ): Promise<DirChildRow[]>;
  protected listDirectory(
    tx: SqlClient,
    dirPosix: string,
    userPath: string,
    scope: "subtree",
  ): Promise<SubtreeRow[]>;
  protected async listDirectory(
    tx: SqlClient,
    dirPosix: string,
    userPath: string,
    scope: "children" | "subtree" = "children",
  ): Promise<DirChildRow[] | SubtreeRow[]> {
    if (this.isHiddenFromReads(dirPosix)) {
      throw new FsError("ENOENT", "no such file or directory", dirPosix);
    }
    const versionId = await this.getCurrentVersionId(tx);
    const lt = pathToLtree(dirPosix, this.workspaceId);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, lt, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    // `self_e` keeps resolveEntry's MATERIALIZED path-lookup-first shape so
    // the generic plan can't invert the join (see resolveEntry).
    const r = await tx.query<SubtreeRow & { self: number }>(
      `WITH self_e AS MATERIALIZED (
         SELECT version_id, node_type
         FROM fs_entries
         WHERE workspace_id = $1 AND path = $3::ltree
       ),
       dir AS MATERIALIZED (
         SELECT s.node_type
         FROM self_e s
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = s.version_id
         WHERE a.descendant_id = $2
         ORDER BY a.depth ASC
         LIMIT 1
       ),
       visible AS (
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
         WHERE EXISTS (SELECT 1 FROM dir WHERE node_type = 'directory')
           AND e.workspace_id = $1
           AND a.descendant_id = $2
           AND e.path <@ $3::ltree
           AND e.path != $3::ltree
           ${scope === "children" ? "AND nlevel(e.path) = nlevel($3::ltree) + 1" : ""}
           AND ${exc.sql}
           AND ${mnt.sql}
         ORDER BY e.path, a.depth ASC
       )
       SELECT 0 AS self, NULL::text AS path, node_type,
              NULL::bytea AS blob_hash, NULL::text AS symlink_target,
              NULL::int AS mode, NULL::bigint AS size_bytes,
              NULL::timestamptz AS mtime, NULL::int AS depth_in_subtree
       FROM dir
       UNION ALL
       SELECT 1, path, node_type, blob_hash, symlink_target, mode,
              size_bytes, mtime, depth_in_subtree
       FROM visible WHERE node_type != $4
       ORDER BY self, path`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    const self = r.rows[0];
    if (!self || Number(self.self) !== 0 || self.node_type === TOMBSTONE) {
      throw new FsError("ENOENT", "no such file or directory", dirPosix);
    }
    if (self.node_type === "symlink") {
      const node = await this.resolveEntryFollowSymlink(tx, dirPosix);
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", userPath);
      const real = ltreeToPath(node.path);
      return scope === "subtree"
        ? this.listVisibleSubtree(tx, real, false)
        : this.listVisibleChildren(tx, real);
    }
    if (self.node_type !== "directory")
      throw new FsError("ENOTDIR", "not a directory, scandir", userPath);
    return r.rows.slice(1);
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
