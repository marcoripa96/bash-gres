import type { CpOptions, MkdirOptions, SqlClient, SqlParam } from "../../types.js";
import { FsError, FsQuotaError, SqlError } from "../../types.js";
import {
  fileName,
  ltreeToPath,
  parentPath,
  pathToLtree,
} from "../../path-encoding.js";
import { validateEmbedding } from "../../search.js";
import { chunkMarkdown, type MarkdownChunk } from "../../chunking.js";
import { TOMBSTONE } from "../internals/constants.js";
import type { InternalEntryShape } from "../internals/entry-shapes.js";
import { sha256 } from "../internals/hashes.js";
import { FsVisibilityBase } from "./visibility.js";

export class FsWriteOpsBase extends FsVisibilityBase {
  // -- Validation -------------------------------------------------------------

  protected validateFileSize(content: string | Uint8Array): void {
    const size =
      typeof content === "string"
        ? new TextEncoder().encode(content).byteLength
        : content.byteLength;
    if (size > this.maxFileSize) {
      throw new Error(
        `File too large: ${size} bytes exceeds maximum of ${this.maxFileSize} bytes`,
      );
    }
  }

  protected async validateNodeCount(tx: SqlClient): Promise<void> {
    // Headroom: as long as the cached count plus this margin is still under
    // `maxFiles`, skip the COUNT(*) and bump the cache optimistically. Once
    // we're inside the margin we re-query on every call so the limit stays
    // strictly enforced near the boundary.
    if (this.tryOptimisticNodeCountIncrement()) return;

    const versionId = await this.getCurrentVersionId(tx);
    const baseParams: SqlParam[] = [this.workspaceId, versionId, TOMBSTONE];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT DISTINCT ON (e.path) e.node_type
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
          WHERE e.workspace_id = $1 AND a.descendant_id = $2
            AND ${exc.sql}
            AND ${mnt.sql}
          ORDER BY e.path, a.depth ASC
        ) v WHERE node_type != $3`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    const actual = Number(r.rows[0]?.count ?? 0);
    this.cachedNodeCount = actual + 1;
    if (r.rows[0] && r.rows[0].count >= this.maxFiles) {
      throw new Error(
        `Node limit reached: ${this.maxFiles} nodes per workspace`,
      );
    }
  }

  protected validatePathDepth(path: string): void {
    const depth = path.split("/").filter(Boolean).length;
    if (depth > this.maxDepth) {
      throw new Error(
        `Path too deep: ${depth} levels exceeds maximum of ${this.maxDepth}`,
      );
    }
  }

  // -- Internal write paths --------------------------------------------------

  protected async upsertBlob(
    tx: SqlClient,
    hash: Uint8Array,
    content: string | Uint8Array,
    sizeBytes: number,
    embedding: number[] | null,
    userPath: string,
  ): Promise<void> {
    await this.validateWorkspaceBytes(tx, hash, sizeBytes, userPath);

    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;

    if (embedding !== null) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await tx.query(
        `INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (workspace_id, hash) DO UPDATE SET
           embedding = COALESCE(fs_blobs.embedding, EXCLUDED.embedding)`,
        [this.workspaceId, hash, textContent, binaryData, sizeBytes, embeddingStr],
      );
    } else {
      await tx.query(
        `INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, hash) DO NOTHING`,
        [this.workspaceId, hash, textContent, binaryData, sizeBytes],
      );
    }
  }

  protected async validateWorkspaceBytes(
    tx: SqlClient,
    hash: Uint8Array,
    sizeBytes: number,
    userPath: string,
  ): Promise<void> {
    if (this.maxWorkspaceBytes === undefined) return;

    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1), -1)`, [
      this.workspaceId,
    ]);

    const existing = await tx.query(
      `SELECT 1 FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    if (existing.rows.length > 0) return;

    const usage = await tx.query<{ stored_blob_bytes: number | string }>(
      `SELECT COALESCE(SUM(size_bytes), 0) AS stored_blob_bytes
       FROM fs_blobs
       WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    const current = Number(usage.rows[0]?.stored_blob_bytes ?? 0);
    if (current + sizeBytes > this.maxWorkspaceBytes) {
      throw new FsQuotaError(
        "workspace byte quota exceeded",
        userPath,
        this.maxWorkspaceBytes,
        current,
        sizeBytes,
      );
    }
  }

  /**
   * Fused blob+entry upsert for the file write hot path. Runs both INSERTs
   * in a single CTE so the round-trip count drops from 2 → 1; data-modifying
   * statements in `WITH` clauses are always evaluated by Postgres regardless
   * of whether the outer query references them. Used only for `node_type =
   * 'file'` writes; symlinks, directories, and bulk copy paths still go
   * through `upsertBlob` / `upsertEntry` separately because they have
   * different shapes (no blob, embedding-only refresh, etc.).
   */
  protected async upsertFileBlobAndEntry(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    hash: Uint8Array,
    content: string | Uint8Array,
    sizeBytes: number,
    embedding: number[] | null,
    mode: number,
  ): Promise<void> {
    await this.validateWorkspaceBytes(tx, hash, sizeBytes, posixPath);

    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const lt = pathToLtree(posixPath, this.workspaceId);

    if (embedding !== null) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await tx.query(
        `WITH b AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)
           ON CONFLICT (workspace_id, hash) DO UPDATE SET
             embedding = COALESCE(fs_blobs.embedding, EXCLUDED.embedding)
           RETURNING 1
         ),
         version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $7
           RETURNING 1
         )
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         VALUES ($1, $7, $8::ltree, $2, 'file', NULL, $9, $5, now())
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          embeddingStr,
          versionId,
          lt,
          mode,
        ],
      );
    } else {
      await tx.query(
        `WITH b AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, hash) DO NOTHING
           RETURNING 1
         ),
         version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $6
           RETURNING 1
         )
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         VALUES ($1, $6, $7::ltree, $2, 'file', NULL, $8, $5, now())
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          versionId,
          lt,
          mode,
        ],
      );
    }
  }

  protected async upsertEntry(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    nodeType: string,
    blobHash: Uint8Array | null,
    sizeBytes: number,
    mode: number,
    symlinkTarget: string | null,
  ): Promise<void> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    // Inline the last_write_at bump as a CTE so the entry write and the
    // version bookkeeping land in one round-trip. Data-modifying CTEs run
    // unconditionally; we only call upsertEntry as part of an actual write,
    // so it's safe to bump regardless of whether the INSERT is a fresh row
    // or an overwrite.
    await tx.query(
      `WITH version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING 1
       )
       INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type,
          symlink_target, mode, size_bytes, mtime)
       VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, now())
       ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
         blob_hash = EXCLUDED.blob_hash,
         node_type = EXCLUDED.node_type,
         symlink_target = EXCLUDED.symlink_target,
         mode = EXCLUDED.mode,
         size_bytes = EXCLUDED.size_bytes,
         mtime = now()`,
      [
        this.workspaceId,
        versionId,
        lt,
        blobHash,
        nodeType,
        symlinkTarget,
        mode,
        sizeBytes,
      ],
    );
  }

  protected async writeTombstone(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
  ): Promise<void> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    await tx.query(
      `WITH version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING 1
       )
       INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type, mode, size_bytes, mtime)
       VALUES ($1, $2, $3::ltree, NULL, $4, 0, 0, now())
       ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
         blob_hash = NULL,
         node_type = $4,
         symlink_target = NULL,
         mode = 0,
         size_bytes = 0,
         mtime = now()`,
      [this.workspaceId, versionId, lt, TOMBSTONE],
    );
  }

  protected async writeTombstonesForVisibleSubtree(
    tx: SqlClient,
    versionId: number,
    rootPosix: string,
    includeRoot: boolean,
  ): Promise<void> {
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const filter = includeRoot ? "" : "AND e.path != $3::ltree";
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      lt,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    await tx.query(
      `WITH version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING 1
       )
       INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type, mode, size_bytes, mtime)
       SELECT $1, $2, visible.path, NULL, $4, 0, 0, now()
       FROM (
         SELECT DISTINCT ON (e.path)
           e.path,
           e.node_type
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
        ) visible
       WHERE visible.node_type != $4
       ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
         blob_hash = NULL,
         node_type = $4,
         symlink_target = NULL,
         mode = 0,
          size_bytes = 0,
          mtime = now()`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
  }

  protected async copyVisibleSubtreeEntries(
    tx: SqlClient,
    versionId: number,
    srcPosix: string,
    destPosix: string,
    includeRoot: boolean,
  ): Promise<void> {
    const srcLt = pathToLtree(srcPosix, this.workspaceId);
    const destLt = pathToLtree(destPosix, this.workspaceId);
    const rootFilter = includeRoot ? "" : "AND visible.path != $3::ltree";
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      srcLt,
      destLt,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    await tx.query(
      `WITH version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING 1
       )
       INSERT INTO fs_entries
         (workspace_id, version_id, path, blob_hash, node_type,
          symlink_target, mode, size_bytes, mtime)
       SELECT
         $1,
         $2,
         CASE
           WHEN visible.path = $3::ltree THEN $4::ltree
           ELSE $4::ltree || subpath(visible.path, nlevel($3::ltree))
         END,
         visible.blob_hash,
         visible.node_type,
         visible.symlink_target,
         visible.mode,
         visible.size_bytes,
         now()
       FROM (
         SELECT DISTINCT ON (e.path)
           e.path,
           e.node_type,
           e.blob_hash,
           e.symlink_target,
           e.mode,
           e.size_bytes
         FROM fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = e.workspace_id AND a.ancestor_id = e.version_id
          WHERE e.workspace_id = $1
            AND a.descendant_id = $2
            AND e.path <@ $3::ltree
            AND ${exc.sql}
            AND ${mnt.sql}
           ORDER BY e.path, a.depth ASC
         ) visible
        WHERE visible.node_type != $5
          ${rootFilter}
        ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
          blob_hash = EXCLUDED.blob_hash,
          node_type = EXCLUDED.node_type,
         symlink_target = EXCLUDED.symlink_target,
         mode = EXCLUDED.mode,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now()`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
  }

  protected async countVisibleSubtreeNodes(
    tx: SqlClient,
    versionId: number,
    rootPosix: string,
  ): Promise<{ total: number; files: number }> {
    const lt = pathToLtree(rootPosix, this.workspaceId);
    const baseParams: SqlParam[] = [
      this.workspaceId,
      versionId,
      lt,
      TOMBSTONE,
    ];
    const exc = this.buildExcludeClause("e.path", baseParams.length + 1);
    const mnt = this.buildMountClause(
      "e.path",
      baseParams.length + 1 + exc.params.length,
    );
    const r = await tx.query<{ total: number; files: number }>(
      `WITH visible AS (
         SELECT DISTINCT ON (e.path)
           e.path,
           e.node_type
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
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE node_type = 'file')::int AS files
        FROM visible
        WHERE node_type != $4`,
      [...baseParams, ...exc.params, ...mnt.params],
    );
    return {
      total: Number(r.rows[0]?.total ?? 0),
      files: Number(r.rows[0]?.files ?? 0),
    };
  }

  /**
   * Apply a pre-fetched entry shape to the destination version's `fs_entries`.
   * Used by batch operations (merge, cherry-pick, revert, detach) to copy
   * within the same workspace without rehashing content. A `null` shape writes
   * a tombstone.
   */
  protected async writeEntryShape(
    tx: SqlClient,
    versionId: number,
    posixPath: string,
    shape: InternalEntryShape | null,
  ): Promise<void> {
    if (shape === null) {
      await this.writeTombstone(tx, versionId, posixPath);
      return;
    }
    await this.upsertEntry(
      tx,
      versionId,
      posixPath,
      shape.type,
      shape.blobHash,
      shape.sizeBytes,
      shape.mode,
      shape.symlinkTarget,
    );
  }

  protected async writeEntryShapes(
    tx: SqlClient,
    versionId: number,
    writes: Array<{ internalPath: string; shape: InternalEntryShape | null }>,
  ): Promise<void> {
    if (writes.length === 0) return;

    const CHUNK_SIZE = 4000;
    for (let start = 0; start < writes.length; start += CHUNK_SIZE) {
      const chunk = writes.slice(start, start + CHUNK_SIZE);
      const params: SqlParam[] = [this.workspaceId, versionId];
      const values: string[] = [];
      for (const w of chunk) {
        const shape = w.shape;
        const idx = params.length + 1;
        values.push(
          `($${idx}::ltree, $${idx + 1}::bytea, $${idx + 2}::text, $${idx + 3}::text, $${idx + 4}::int, $${idx + 5}::bigint)`,
        );
        params.push(
          pathToLtree(w.internalPath, this.workspaceId),
          shape?.blobHash ?? null,
          shape?.type ?? TOMBSTONE,
          shape?.symlinkTarget ?? null,
          shape?.mode ?? 0,
          shape?.sizeBytes ?? 0,
        );
      }

      await tx.query(
        `WITH input(path, blob_hash, node_type, symlink_target, mode, size_bytes) AS (
           VALUES ${values.join(", ")}
         ),
         version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $2
           RETURNING 1
         )
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         SELECT $1, $2, path, blob_hash, node_type, symlink_target, mode, size_bytes, now()
         FROM input
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = EXCLUDED.blob_hash,
           node_type = EXCLUDED.node_type,
           symlink_target = EXCLUDED.symlink_target,
           mode = EXCLUDED.mode,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        params,
      );
    }
  }

  protected async internalWriteFile(
    tx: SqlClient,
    versionId: number,
    path: string,
    content: string | Uint8Array,
    precomputedEmbedding?: number[] | null,
    parentKnownMissing: boolean = false,
  ): Promise<void> {
    this.validateFileSize(content);
    this.validatePathDepth(path);

    const isText = typeof content === "string";
    const bytes = isText
      ? new TextEncoder().encode(content)
      : (content as Uint8Array);
    const sizeBytes = bytes.byteLength;
    const hash = sha256(bytes);

    let embedding: number[] | null = null;
    if (precomputedEmbedding !== undefined) {
      embedding = precomputedEmbedding;
    } else if (
      isText &&
      this.embed &&
      content.length > 0 &&
      (await this.blobsHasEmbedding(tx))
    ) {
      embedding = await this.maybeEmbed(tx, hash, content);
    }

    // Embedding writes still take the older two-step path because the blob
    // INSERT shape differs (extra column, different ON CONFLICT projection)
    // and re-using the fused statement would force everything through a
    // CASE-laden query.
    if (embedding !== null) {
      const parentPosix = parentPath(path);
      const resolved = await this.resolveEntries(tx, [parentPosix, path]);
      const parent = resolved.get(parentPosix) ?? null;
      if (!parent)
        throw new FsError("ENOENT", "no such file or directory, open", path);
      if (parent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, open", path);
      const existing = resolved.get(path) ?? null;
      if (existing?.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, open",
          path,
        );
      if (!existing) {
        await this.validateNodeCount(tx);
      }
      await this.upsertFileBlobAndEntry(
        tx,
        versionId,
        path,
        hash,
        content,
        sizeBytes,
        embedding,
        0o644,
      );
      await this.maybeChunk(tx, hash, content);
      return;
    }

    // Workspace-byte quota check (no-op when maxWorkspaceBytes is unset).
    // Runs before the fused query so a quota refusal never persists either
    // the blob row or the entry row.
    await this.validateWorkspaceBytes(tx, hash, sizeBytes, path);

    const parentPosix = parentPath(path);
    const textContent = isText ? content : null;
    const binaryData = isText ? null : (content as Uint8Array);

    // First attempt: skip mkdir entirely. The fused query validates the
    // parent itself and reports 'enoent' if missing — at which point we
    // create the parent and retry. The hot path (parent already exists)
    // avoids the wasted resolveEntry that internalMkdir(parent, recursive)
    // would otherwise issue.
    let outcome: { status: string; inserted: boolean | null } =
      parentKnownMissing && parentPosix !== "/"
        ? { status: "enoent", inserted: null }
        : await this.attemptFusedWrite(
            tx,
            versionId,
            path,
            parentPosix,
            hash,
            textContent,
            binaryData,
            sizeBytes,
          );

    if (outcome.status === "enoent" && parentPosix !== "/") {
      // Parent missing — create it then retry. The retry's validateNodeCount
      // increment is paired with the same decrement-on-failure semantics.
      await this.internalMkdirForWriteParent(tx, versionId, parentPosix);
      outcome = await this.attemptFusedWrite(
        tx,
        versionId,
        path,
        parentPosix,
        hash,
        textContent,
        binaryData,
        sizeBytes,
      );
    }

    if (outcome.status !== "ok") {
      if (outcome.status === "enoent")
        throw new FsError("ENOENT", "no such file or directory, open", path);
      if (outcome.status === "enotdir")
        throw new FsError("ENOTDIR", "not a directory, open", path);
      if (outcome.status === "eisdir")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, open",
          path,
        );
      throw new Error(`internalWriteFile: unexpected status '${outcome.status}'`);
    }

    await this.maybeChunk(tx, hash, content);
  }

  /**
   * Maintain the chunk-level index for a just-written blob. Chunks key off
   * the blob hash, so an unchanged rewrite (or the same content at another
   * path) costs a single existence probe. Runs in the write's transaction:
   * a failed write never leaves chunks behind, and the fs_blobs row the FK
   * needs is already in place.
   */
  protected async maybeChunk(
    tx: SqlClient,
    hash: Uint8Array,
    content: string | Uint8Array,
  ): Promise<void> {
    if (!this.chunking || typeof content !== "string" || content.length === 0)
      return;
    let existing;
    try {
      existing = await tx.query(
        `SELECT 1 FROM fs_blob_chunks
         WHERE workspace_id = $1 AND blob_hash = $2
         LIMIT 1`,
        [this.workspaceId, hash],
      );
    } catch (e) {
      this.rethrowMissingChunkTable(e);
    }
    if (existing.rows.length > 0) return;
    await this.insertChunkRows(tx, hash, chunkMarkdown(content, this.chunking));
  }

  /**
   * Turn Postgres's "relation does not exist" for `fs_blob_chunks` into the
   * migration story. The table ships with newer `setup()` runs; a database
   * migrated by an older bash-gres doesn't have it, and the chunking feature
   * fails fast with instructions rather than a bare SQL error. Databases
   * that never enable `chunking` are untouched — the table is only queried
   * when the feature (or one of its explicit APIs) is used.
   */
  protected rethrowMissingChunkTable(e: unknown): never {
    if (
      e instanceof SqlError &&
      e.code === "42P01" &&
      /fs_blob_chunks/.test(e.message)
    ) {
      throw new Error(
        "the fs_blob_chunks table does not exist in this database — " +
          "re-run setup() (idempotent) to migrate it in, then " +
          "backfillChunks() once per workspace to index pre-existing content",
      );
    }
    throw e;
  }

  /** Batched insert of one blob's chunk rows (no-op on an empty set). */
  protected async insertChunkRows(
    tx: SqlClient,
    hash: Uint8Array,
    chunks: MarkdownChunk[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    const params: SqlParam[] = [this.workspaceId, hash];
    const values: string[] = [];
    for (const chunk of chunks) {
      const idx = params.length + 1;
      values.push(
        `($1, $2, $${idx}::int, $${idx + 1}::int, $${idx + 2}::int, $${idx + 3}::text, $${idx + 4}::text, $${idx + 5}::bytea)`,
      );
      params.push(
        chunk.index,
        chunk.startLine,
        chunk.endLine,
        chunk.headingPath,
        chunk.content,
        sha256(new TextEncoder().encode(chunk.content)),
      );
    }
    // ON CONFLICT DO NOTHING: a concurrent writer of the same blob may have
    // raced past the existence probe; both compute identical rows.
    await tx.query(
      `INSERT INTO fs_blob_chunks
         (workspace_id, blob_hash, chunk_index, start_line, end_line,
          heading_path, content, content_hash)
       VALUES ${values.join(", ")}
       ON CONFLICT (workspace_id, blob_hash, chunk_index) DO NOTHING`,
      params,
    );
  }

  protected async tryFastWriteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<{ status: string; inserted: boolean | null } | null> {
    if (
      this.txClient ||
      !this.permissions.write ||
      this.cachedVersionId === null ||
      this.maxWorkspaceBytes !== undefined ||
      this.embed ||
      // Chunk maintenance needs the transactional path (probe + insert).
      this.chunking
    ) {
      return null;
    }

    this.validatePathDepth(path);

    const isText = typeof content === "string";
    const bytes = isText
      ? new TextEncoder().encode(content)
      : (content as Uint8Array);
    const sizeBytes = bytes.byteLength;
    if (sizeBytes > this.maxFileSize) {
      throw new Error(
        `File too large: ${sizeBytes} bytes exceeds maximum of ${this.maxFileSize} bytes`,
      );
    }

    if (!this.tryOptimisticNodeCountIncrement()) return null;

    const hash = sha256(bytes);
    const parentPosix = parentPath(path);
    const parentLt = pathToLtree(parentPosix, this.workspaceId);
    const targetLt = pathToLtree(path, this.workspaceId);
    const textContent = isText ? content : null;
    const binaryData = isText ? null : (content as Uint8Array);

    try {
      const result = await this.client.query<{
        status: string;
        inserted: boolean | null;
      }>(
        `WITH _ws AS MATERIALIZED (
           SELECT
             set_config('app.workspace_id', $10, true) AS ws,
             set_config('statement_timeout', $11, true) AS st
         ),
         lookups AS MATERIALIZED (
           SELECT DISTINCT ON (e.path)
             e.path AS path,
             e.node_type
           FROM _ws
           CROSS JOIN fs_entries e
           JOIN version_ancestors a
             ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
           WHERE e.workspace_id = $1
             AND e.path = ANY(ARRAY[$7::ltree, $8::ltree])
             AND a.descendant_id = $6
           ORDER BY e.path, a.depth ASC
         ),
         validation AS (
           SELECT
             CASE
               WHEN COALESCE(
                 (SELECT node_type FROM lookups WHERE path = $7::ltree),
                 'missing'
               ) IN ('missing', 'tombstone')
                 THEN 'enoent'
               WHEN (SELECT node_type FROM lookups WHERE path = $7::ltree) <> 'directory'
                 THEN 'enotdir'
               WHEN COALESCE(
                 (SELECT node_type FROM lookups WHERE path = $8::ltree),
                 ''
               ) = 'directory'
                 THEN 'eisdir'
               ELSE 'ok'
             END AS status
           FROM _ws
         ),
         blob_upsert AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
           SELECT $1, $2, $3, $4, $5
           FROM validation WHERE status = 'ok'
           ON CONFLICT (workspace_id, hash) DO NOTHING
           RETURNING 1
         ),
         entry_upsert AS (
           INSERT INTO fs_entries
             (workspace_id, version_id, path, blob_hash, node_type,
              symlink_target, mode, size_bytes, mtime)
           SELECT $1, $6, $8::ltree, $2, 'file', NULL, $9, $5, now()
           FROM validation WHERE status = 'ok'
           ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
             blob_hash = EXCLUDED.blob_hash,
             node_type = EXCLUDED.node_type,
             symlink_target = EXCLUDED.symlink_target,
             mode = EXCLUDED.mode,
             size_bytes = EXCLUDED.size_bytes,
             mtime = now()
           RETURNING (xmax = 0) AS inserted
         ),
         version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $6
             AND EXISTS (SELECT 1 FROM validation WHERE status = 'ok')
           RETURNING 1
         )
         SELECT validation.status,
                (SELECT inserted FROM entry_upsert) AS inserted
         FROM validation`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          this.cachedVersionId,
          parentLt,
          targetLt,
          0o644,
          this.workspaceId,
          String(this.statementTimeoutMs),
        ],
      );

      const row = result.rows[0]!;
      if (row.status !== "ok" || row.inserted === false) {
        this.decrementCachedNodeCount();
      }
      return row;
    } catch (e) {
      this.decrementCachedNodeCount();
      if (e instanceof SqlError && e.code === "25006") {
        throw new FsError("EPERM", "read-only file system", "/");
      }
      throw e;
    }
  }

  /**
   * Run the fused validation+blob+entry upsert and return the status without
   * throwing. Manages the optimistic node-count cache: increments before the
   * write, decrements on validation failure, on overwrite (xmax != 0), or
   * on SQL error. Caller is responsible for translating a non-'ok' status
   * into an `FsError`.
   */
  private async attemptFusedWrite(
    tx: SqlClient,
    versionId: number,
    path: string,
    parentPosix: string,
    hash: Uint8Array,
    textContent: string | null,
    binaryData: Uint8Array | null,
    sizeBytes: number,
  ): Promise<{ status: string; inserted: boolean | null }> {
    const parentLt = pathToLtree(parentPosix, this.workspaceId);
    const targetLt = pathToLtree(path, this.workspaceId);

    // Optimistic node-count check: assume we'll insert. If the upsert turns
    // out to be an overwrite (xmax != 0) or fails validation we undo the
    // increment below. validateNodeCount() throws at the boundary; if it
    // throws we never run the fused query.
    await this.validateNodeCount(tx);

    let result: { rows: Array<{ status: string; inserted: boolean | null }> };
    try {
      result = await tx.query<{ status: string; inserted: boolean | null }>(
        `WITH lookups AS MATERIALIZED (
           SELECT DISTINCT ON (e.path)
             e.path AS path,
             e.node_type
           FROM fs_entries e
           JOIN version_ancestors a
             ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
           WHERE e.workspace_id = $1
             AND e.path = ANY(ARRAY[$7::ltree, $8::ltree])
             AND a.descendant_id = $6
           ORDER BY e.path, a.depth ASC
         ),
         validation AS (
           SELECT
             CASE
               WHEN COALESCE(
                 (SELECT node_type FROM lookups WHERE path = $7::ltree),
                 'missing'
               ) IN ('missing', 'tombstone')
                 THEN 'enoent'
               WHEN (SELECT node_type FROM lookups WHERE path = $7::ltree) <> 'directory'
                 THEN 'enotdir'
               WHEN COALESCE(
                 (SELECT node_type FROM lookups WHERE path = $8::ltree),
                 ''
               ) = 'directory'
                 THEN 'eisdir'
               ELSE 'ok'
             END AS status
         ),
         blob_upsert AS (
           INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
           SELECT $1, $2, $3, $4, $5
           FROM validation WHERE status = 'ok'
           ON CONFLICT (workspace_id, hash) DO NOTHING
           RETURNING 1
         ),
         entry_upsert AS (
           INSERT INTO fs_entries
             (workspace_id, version_id, path, blob_hash, node_type,
              symlink_target, mode, size_bytes, mtime)
           SELECT $1, $6, $8::ltree, $2, 'file', NULL, $9, $5, now()
           FROM validation WHERE status = 'ok'
           ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
             blob_hash = EXCLUDED.blob_hash,
             node_type = EXCLUDED.node_type,
             symlink_target = EXCLUDED.symlink_target,
             mode = EXCLUDED.mode,
             size_bytes = EXCLUDED.size_bytes,
             mtime = now()
           RETURNING (xmax = 0) AS inserted
         ),
         version_bump AS (
           UPDATE fs_versions SET last_write_at = now()
           WHERE workspace_id = $1 AND id = $6
             AND EXISTS (SELECT 1 FROM validation WHERE status = 'ok')
           RETURNING 1
         )
         SELECT validation.status,
                (SELECT inserted FROM entry_upsert) AS inserted
         FROM validation`,
        [
          this.workspaceId,
          hash,
          textContent,
          binaryData,
          sizeBytes,
          versionId,
          parentLt,
          targetLt,
          0o644,
        ],
      );
    } catch (e) {
      this.decrementCachedNodeCount();
      throw e;
    }

    const row = result.rows[0]!;
    if (row.status !== "ok" || row.inserted === false) {
      // Either validation rejected the write or it turned into an overwrite.
      // Either way, no new entry actually landed — undo the optimistic
      // increment so the cached count stays accurate.
      this.decrementCachedNodeCount();
    }
    return row;
  }

  private async internalMkdirForWriteParent(
    tx: SqlClient,
    versionId: number,
    path: string,
  ): Promise<void> {
    this.validatePathDepth(path);
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return;

    let current = "/";
    const paths = segments.map((segment) => {
      current = current === "/" ? `/${segment}` : `${current}/${segment}`;
      return current;
    });

    const params: SqlParam[] = [this.workspaceId, versionId];
    const values = paths.map((p, i) => {
      params.push(pathToLtree(p, this.workspaceId), i + 1);
      const pathParam = params.length - 1;
      const ordParam = params.length;
      return `($${pathParam}::ltree, $${ordParam}::int)`;
    });

    const r = await tx.query<{ status: string; bad_path: string | null }>(
      `WITH wanted(path, ord) AS (
         VALUES ${values.join(", ")}
       ),
       visible AS MATERIALIZED (
         SELECT DISTINCT ON (w.path)
           w.path,
           w.ord,
           e.node_type
         FROM wanted w
         JOIN fs_entries e
           ON e.workspace_id = $1 AND e.path = w.path
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE a.descendant_id = $2
         ORDER BY w.path, a.depth ASC
       ),
       invalid AS (
         SELECT path
         FROM visible
         WHERE node_type NOT IN ('directory', 'tombstone')
         ORDER BY ord
         LIMIT 1
       ),
       inserted AS (
         INSERT INTO fs_entries
           (workspace_id, version_id, path, blob_hash, node_type,
            symlink_target, mode, size_bytes, mtime)
         SELECT $1, $2, w.path, NULL, 'directory', NULL, $${params.length + 1}, 0, now()
         FROM wanted w
         LEFT JOIN visible v ON v.path = w.path
         WHERE NOT EXISTS (SELECT 1 FROM invalid)
           AND COALESCE(v.node_type, 'missing') != 'directory'
         ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
           blob_hash = NULL,
           node_type = EXCLUDED.node_type,
           symlink_target = NULL,
           mode = EXCLUDED.mode,
           size_bytes = 0,
           mtime = now()
         RETURNING 1
       ),
       version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = $2
           AND NOT EXISTS (SELECT 1 FROM invalid)
         RETURNING 1
       )
       SELECT
         CASE WHEN EXISTS (SELECT 1 FROM invalid) THEN 'enotdir' ELSE 'ok' END AS status,
         (SELECT path::text FROM invalid) AS bad_path`,
      [...params, 0o755],
    );

    const row = r.rows[0]!;
    if (row.status === "enotdir") {
      throw new FsError(
        "ENOTDIR",
        "not a directory, mkdir",
        row.bad_path ? ltreeToPath(row.bad_path) : path,
      );
    }
    if (row.status !== "ok") {
      throw new Error(
        `internalMkdirForWriteParent: unexpected status '${row.status}'`,
      );
    }
  }

  private decrementCachedNodeCount(): void {
    if (this.cachedNodeCount !== null && this.cachedNodeCount > 0) {
      this.cachedNodeCount--;
    }
  }

  private tryOptimisticNodeCountIncrement(): boolean {
    const HEADROOM = 16;
    if (
      this.cachedNodeCount !== null &&
      this.cachedNodeCount + HEADROOM < this.maxFiles
    ) {
      this.cachedNodeCount++;
      return true;
    }
    return false;
  }

  protected async blobsHasEmbedding(tx: SqlClient): Promise<boolean> {
    if (this.blobsHasEmbeddingCache !== null)
      return this.blobsHasEmbeddingCache;
    const r = await tx.query<{ has_col: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'fs_blobs' AND column_name = 'embedding'
       ) AS has_col`,
    );
    this.blobsHasEmbeddingCache = r.rows[0]?.has_col ?? false;
    return this.blobsHasEmbeddingCache;
  }

  protected async maybeEmbed(
    tx: SqlClient,
    hash: Uint8Array,
    content: string,
  ): Promise<number[] | null> {
    if (!this.embed) return null;
    const existing = await tx.query<{ has_embedding: boolean }>(
      `SELECT (embedding IS NOT NULL) AS has_embedding
       FROM fs_blobs
       WHERE workspace_id = $1 AND hash = $2
       LIMIT 1`,
      [this.workspaceId, hash],
    );
    if (existing.rows[0]?.has_embedding) return null;
    const embedding = await this.embed(content);
    validateEmbedding(embedding, this.embeddingDimensions);
    return embedding;
  }

  // -- Internal mkdir ---------------------------------------------------------

  protected async internalMkdir(
    tx: SqlClient,
    versionId: number,
    path: string,
    options?: MkdirOptions,
  ): Promise<void> {
    this.validatePathDepth(path);
    const recursive = options?.recursive ?? false;

    if (recursive) {
      const segments = path.split("/").filter(Boolean);
      let current = "/";
      for (const segment of segments) {
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        const visible = await this.resolveEntry(tx, current);
        if (visible) {
          if (visible.node_type !== "directory") {
            throw new FsError("ENOTDIR", "not a directory, mkdir", current);
          }
          // already a visible directory; nothing to do
          continue;
        }
        await this.upsertEntry(
          tx,
          versionId,
          current,
          "directory",
          null,
          0,
          0o755,
          null,
        );
      }
    } else {
      const existing = await this.resolveEntry(tx, path);
      if (existing)
        throw new FsError("EEXIST", "file already exists, mkdir", path);
      const parent = await this.resolveEntry(tx, parentPath(path));
      if (!parent)
        throw new FsError("ENOENT", "no such file or directory, mkdir", path);
      if (parent.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, mkdir", path);
      await this.upsertEntry(
        tx,
        versionId,
        path,
        "directory",
        null,
        0,
        0o755,
        null,
      );
    }
  }

  // -- Internal cp ------------------------------------------------------------

  protected async internalCp(
    tx: SqlClient,
    versionId: number,
    src: string,
    dest: string,
    options?: CpOptions,
    counter?: { count: number },
  ): Promise<void> {
    const nodeCounter = counter ?? { count: 0 };

    if (dest.startsWith(src + "/") || dest === src) {
      throw new FsError(
        "EINVAL",
        "cannot copy to a subdirectory of itself, cp",
        src,
      );
    }

    const srcEntry = await this.resolveEntry(tx, src);
    if (!srcEntry)
      throw new FsError("ENOENT", "no such file or directory, cp", src);

    nodeCounter.count++;
    if (nodeCounter.count > this.maxCpNodes) {
      throw new Error(
        `cp: too many nodes (exceeds limit of ${this.maxCpNodes})`,
      );
    }

    if (srcEntry.node_type === "directory") {
      if (!options?.recursive) {
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, cp",
          src,
        );
      }
      const existingDest = await this.resolveEntry(tx, dest);
      if (!existingDest) {
        await this.internalMkdir(tx, versionId, dest, { recursive: true });
        const copied = await this.countVisibleSubtreeNodes(tx, versionId, src);
        if (copied.total > this.maxCpNodes) {
          throw new Error(
            `cp: too many nodes (exceeds limit of ${this.maxCpNodes})`,
          );
        }
        if (copied.files > 0) {
          const currentCount = await this.globalVisibleCount(tx, versionId);
          if (currentCount + copied.files > this.maxFiles) {
            throw new Error(
              `Node limit reached: ${this.maxFiles} nodes per workspace`,
            );
          }
        }
        await this.copyVisibleSubtreeEntries(tx, versionId, src, dest, true);
        return;
      }
      if (existingDest.node_type === "directory") {
        const destChildren = await this.listVisibleChildren(tx, dest);
        if (destChildren.length === 0) {
          const copied = await this.countVisibleSubtreeNodes(tx, versionId, src);
          if (copied.total > this.maxCpNodes) {
            throw new Error(
              `cp: too many nodes (exceeds limit of ${this.maxCpNodes})`,
            );
          }
          if (copied.files > 0) {
            const currentCount = await this.globalVisibleCount(tx, versionId);
            if (currentCount + copied.files > this.maxFiles) {
              throw new Error(
                `Node limit reached: ${this.maxFiles} nodes per workspace`,
              );
            }
          }
          await this.copyVisibleSubtreeEntries(tx, versionId, src, dest, false);
          return;
        }
      }
      await this.internalMkdir(tx, versionId, dest, { recursive: true });
      const children = await this.listVisibleChildren(tx, src);
      for (const child of children) {
        const name = fileName(ltreeToPath(child.path));
        const srcChild = src === "/" ? `/${name}` : `${src}/${name}`;
        const destChild = dest === "/" ? `/${name}` : `${dest}/${name}`;
        await this.internalCp(
          tx,
          versionId,
          srcChild,
          destChild,
          options,
          nodeCounter,
        );
      }
      return;
    }

    if (srcEntry.node_type === "symlink") {
      // Recreate the symlink at dest. validatePathDepth happens via guard upstream;
      // re-validate target boundary.
      this.validatePathDepth(dest);
      const target = srcEntry.symlink_target ?? "";
      const sizeBytes = new TextEncoder().encode(target).byteLength;
      await this.upsertEntry(
        tx,
        versionId,
        dest,
        "symlink",
        null,
        sizeBytes,
        0o777,
        target,
      );
      return;
    }

    // file: share the blob (same blob_hash), insert new entry at dest
    if (srcEntry.blob_hash) {
      // confirm parent dir exists
      const parentEntry = await this.resolveEntry(tx, parentPath(dest));
      if (!parentEntry)
        throw new FsError("ENOENT", "no such file or directory, cp", dest);
      if (parentEntry.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, cp", dest);
      const existing = await this.resolveEntry(tx, dest);
      if (existing?.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, cp",
          dest,
        );
      if (!existing) {
        await this.validateNodeCount(tx);
      }
      await this.upsertEntry(
        tx,
        versionId,
        dest,
        "file",
        srcEntry.blob_hash,
        Number(srcEntry.size_bytes),
        srcEntry.mode,
        null,
      );
    } else {
      // Empty file (no blob_hash). Create empty entry.
      await this.internalWriteFile(tx, versionId, dest, "", null);
    }
  }
}
