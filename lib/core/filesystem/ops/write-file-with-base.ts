import type {
  NodeType,
  SqlClient,
  WriteBase,
  WriteFileWithBaseOptions,
  WriteFileWithBaseResult,
} from "../../types.js";
import {
  FsBaseUnavailableError,
  FsWriteConflictError,
  SqlError,
} from "../../types.js";
import { normalizePath, pathToLtree } from "../../path-encoding.js";
import { VERSION_LOCKED_CTE } from "../internals/bump-version.js";
import { blobGuardFrom } from "../internals/blob-guard.js";
import {
  EMPTY_CONTENT_HASH,
  blobHashEqual,
  bytesKey,
  hexToBytes,
  prepareBlob,
  type PreparedBlob,
} from "../internals/hashes.js";
import {
  blobText,
  toMergeSide,
  type InternalEntryShape,
} from "../internals/entry-shapes.js";
import { frozenVersionError, readOnlyError } from "../base/state.js";
import {
  op,
  type FastWriteTarget,
  type FilesystemOpsContext,
} from "./context.js";
import { checkResolution } from "./resolution.js";

const OP = "writeFileWithBase";

/**
 * Write `content` at `path` if the file still holds what the caller started
 * from (`base`); otherwise hand base/ours/theirs to `resolve` and store what
 * it returns. The comparison and the write are one atomic step: the version
 * row is locked before the stored file is read, so no other write to the
 * version lands in between.
 *
 * Rules, against what is stored once the lock is held:
 *   - stored == content: `"unchanged"`, nothing written.
 *   - stored == base (an absent path or tombstone matches a `null` base):
 *     `"written"`.
 *   - a directory or symlink at the path: `FsWriteConflictError`
 *     (`"not-a-file"`), resolver not called.
 *   - otherwise the resolver settles it (`"merged"` / `"removed"`); without
 *     one, or when it declines, `FsWriteConflictError` and nothing written.
 *     A base named by hash whose blob is gone: `FsBaseUnavailableError`.
 *
 * A frozen version is `EPERM` before anything is compared. Parents, size
 * limit, node count and quota behave as `writeFile`'s; an overwrite keeps the
 * file's mode (writeFile resets it to 0644).
 *
 * Fast path (one statement): with chunking and maxWorkspaceBytes off, a
 * known version id, and the path a file row owned by this version. Outside a
 * transaction it needs no BEGIN/COMMIT; in one (fs.transaction(), or a handle
 * built on a Drizzle transaction) it is one more statement. It reads the
 * entry and the version row's xmin from its snapshot and locks the version
 * row only `WHERE xmin = <snapshot xmin>` (see `fastStatement`), so a write
 * that committed after the snapshot leaves it with nothing locked or
 * written. Under REPEATABLE READ or SERIALIZABLE the same race is a
 * serialization failure instead. Otherwise the slow path: lock (then the
 * same statement again when only a stale snapshot stopped it), else a
 * fresh-snapshot read, the resolver, and the write. `"unchanged"` writes
 * nothing and leaves `last_write_at` alone on both paths.
 */
export const writeFileWithBase = op(async function writeFileWithBase<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  path: string,
  content: string | Uint8Array,
  opts: WriteFileWithBaseOptions,
): Promise<WriteFileWithBaseResult> {
  const userPath = normalizePath(path);
  const internal = ctx.guardWrite(path);
  ctx.validateWrite(internal, content);
  const base = parseBase(opts?.base);
  const incoming = prepareBlob(content);

  /** The one-statement write, when the handle and base allow it. */
  const tryFast = async (
    on?: { client: SqlClient; versionId: number },
  ): Promise<FastOutcome | null> => {
    const target = ctx.fastWriteTarget();
    if (base.kind === "absent" || target === null) return null;
    return fastStatement(
      ctx.workspaceId,
      { ...target, ...on },
      internal,
      base.hash,
      incoming,
    );
  };

  const first = await tryFast();
  if (first?.kind === "done") return first.result;

  return ctx.withWorkspace(async (tx) => {
    const versionId = await ctx.getCurrentVersionId(tx);
    await lockVersionAndAncestors(tx, ctx.workspaceId, versionId);

    // With the version row locked, the one-statement write settles a base
    // that matches a file this version owns (its xmin check passes: the row
    // is locked by us, not updated). Skipped when the first attempt already
    // saw a mismatch or an entry it cannot handle: only a stale snapshot, or
    // no attempt at all, can turn out differently now.
    if (first?.kind !== "decide") {
      const locked = await tryFast({ client: tx, versionId });
      if (locked?.kind === "done") return locked.result;
    }

    const baseHash = base.kind === "absent" ? null : base.hash;
    const needTexts = opts.resolve !== undefined;
    const cur = await readCurrent(tx, ctx.workspaceId, versionId, internal, {
      baseHash,
      incomingHash: incoming.hash,
      needTexts,
      baseFromStore: base.kind === "hash",
    });

    if (cur.shape && cur.shape.type !== "file") {
      throw new FsWriteConflictError(userPath, "not-a-file", null, cur.shape.type);
    }
    const storedHash = cur.shape ? (cur.shape.blobHash ?? EMPTY_CONTENT_HASH) : null;
    const storedHex = storedHash ? bytesKey(storedHash) : null;

    if (storedHash && blobHashEqual(storedHash, incoming.hash)) {
      return { outcome: "unchanged", hash: storedHex };
    }
    const baseMatches =
      baseHash === null ? storedHash === null : blobHashEqual(storedHash, baseHash);
    if (baseMatches) {
      await store(ctx, tx, versionId, internal, cur.shape, incoming, content);
      return { outcome: "written", hash: bytesKey(incoming.hash) };
    }

    if (!opts.resolve) {
      throw new FsWriteConflictError(userPath, "no-resolver", storedHex, cur.shape ? "file" : null);
    }

    let baseText: string | null = null;
    if (base.kind === "content") {
      baseText = blobText(
        typeof base.content === "string"
          ? { content: base.content, binary: null }
          : { content: null, binary: base.content },
      );
    } else if (base.kind === "hash") {
      if (!cur.baseFound) throw new FsBaseUnavailableError(userPath, base.hex);
      baseText = cur.baseText;
    }

    const mode = cur.shape?.mode ?? 0o644;
    const now = new Date();
    const fileShape = (hash: Uint8Array, sizeBytes: number): InternalEntryShape => ({
      type: "file",
      blobHash: hash,
      symlinkTarget: null,
      mode,
      sizeBytes,
      mtime: now,
    });
    const resolution = checkResolution(
      await opts.resolve({
        path: userPath,
        base:
          base.kind === "absent"
            ? null
            : toMergeSide(
                fileShape(base.hash, base.kind === "content" ? base.size : cur.baseSize),
                baseText,
              ),
        ours: toMergeSide(cur.shape, cur.oursText),
        theirs: toMergeSide(
          fileShape(incoming.hash, incoming.sizeBytes),
          blobText({ content: incoming.text, binary: incoming.binary }),
        ),
      }),
      OP,
      userPath,
    );
    if (resolution === null) {
      throw new FsWriteConflictError(userPath, "declined", storedHex, cur.shape ? "file" : null);
    }
    if ("remove" in resolution) {
      if (cur.shape) await ctx.writeEntryShape(tx, versionId, internal, null);
      return { outcome: "removed", hash: null };
    }
    // Size and quota are checked by the write below (overwriteFile or
    // writeFile's path), before anything is stored.
    const merged = prepareBlob(resolution.content);
    if (!storedHash || !blobHashEqual(storedHash, merged.hash)) {
      await store(ctx, tx, versionId, internal, cur.shape, merged, resolution.content);
    }
    return { outcome: "merged", hash: bytesKey(merged.hash), content: resolution.content };
  });
});

type ParsedBase =
  | { kind: "absent" }
  | { kind: "hash"; hash: Uint8Array; hex: string }
  | { kind: "content"; hash: Uint8Array; size: number; content: string | Uint8Array };

function parseBase(base: WriteBase | undefined): ParsedBase {
  if (base === null) return { kind: "absent" };
  if (base !== undefined && typeof base === "object") {
    if ("hash" in base && typeof base.hash === "string") {
      if (!/^[0-9a-fA-F]{64}$/.test(base.hash)) {
        throw new Error(`${OP}: base.hash must be a hex sha256 (64 hex digits)`);
      }
      const hex = base.hash.toLowerCase();
      return { kind: "hash", hash: hexToBytes(hex), hex };
    }
    if (
      "content" in base &&
      (typeof base.content === "string" || base.content instanceof Uint8Array)
    ) {
      const blob = prepareBlob(base.content);
      return { kind: "content", hash: blob.hash, size: blob.sizeBytes, content: base.content };
    }
  }
  throw new Error(
    `${OP}: base must be { hash: string }, { content: string | Uint8Array }, or null`,
  );
}

/**
 * Store `blob` at `internal`. An existing file keeps its mode and needs no
 * parent or node-count work; a new file goes through writeFile's path
 * (parents created, node count, quota).
 */
async function store<TFs>(
  ctx: FilesystemOpsContext<TFs>,
  tx: SqlClient,
  versionId: number,
  internal: string,
  existing: InternalEntryShape | null,
  blob: PreparedBlob,
  content: string | Uint8Array,
): Promise<void> {
  if (existing === null) {
    await ctx.writeNewFile(tx, versionId, internal, content);
    return;
  }
  await ctx.overwriteFile(tx, versionId, internal, blob, existing.mode);
}

/**
 * Lock, in id order, the version row FOR NO KEY UPDATE (writes bump it, so
 * they wait) and every unfrozen, undeleted ancestor it reads through FOR
 * SHARE (a write to a fork's parent can change the inherited file too). One
 * statement; the per-row LATERAL keeps the id order while mixing lock
 * strengths. A frozen version is refused here, before any comparison.
 */
async function lockVersionAndAncestors(
  tx: SqlClient,
  workspaceId: string,
  versionId: number,
): Promise<void> {
  const r = await tx.query<{ frozen: boolean | null }>(
    `SELECT own.frozen
     FROM (
       SELECT ancestor_id AS id FROM version_ancestors
       WHERE workspace_id = $1 AND descendant_id = $2
       ORDER BY ancestor_id
     ) u
     LEFT JOIN LATERAL (
       SELECT v.frozen_at IS NOT NULL AS frozen FROM fs_versions v
       WHERE v.workspace_id = $1 AND v.id = u.id AND u.id = $2
       FOR NO KEY UPDATE
     ) own ON true
     LEFT JOIN LATERAL (
       SELECT 1 AS locked FROM fs_versions v
       WHERE v.workspace_id = $1 AND v.id = u.id AND u.id <> $2
         AND v.frozen_at IS NULL AND v.deleted_at IS NULL
       FOR SHARE
     ) anc ON true
     ORDER BY u.id`,
    [workspaceId, versionId],
  );
  if (r.rows.some((row) => row.frozen === true)) {
    throw frozenVersionError();
  }
}

interface CurrentState {
  /** The visible entry; `null` when absent or a tombstone. */
  shape: InternalEntryShape | null;
  /** The stored file's text, when the resolver may need it. */
  oursText: string | null;
  baseFound: boolean;
  baseText: string | null;
  /** The stored base blob's size, when it was read. */
  baseSize: number;
}

/**
 * The visible entry at `internal`, read with a snapshot taken after the
 * locks. Blob contents come back only when a resolver may run (the stored
 * file differs from both base and incoming), so a matching base reads no
 * content.
 */
async function readCurrent(
  tx: SqlClient,
  workspaceId: string,
  versionId: number,
  internal: string,
  q: {
    baseHash: Uint8Array | null;
    incomingHash: Uint8Array;
    needTexts: boolean;
    baseFromStore: boolean;
  },
): Promise<CurrentState> {
  const r = await tx.query<{
    node_type: string | null;
    blob_hash: Uint8Array | null;
    symlink_target: string | null;
    mode: number | null;
    size_bytes: number | string | null;
    mtime: Date | null;
    ours_content: string | null;
    ours_binary: Uint8Array | null;
    base_found: boolean | null;
    base_content: string | null;
    base_binary: Uint8Array | null;
    base_size: number | string | null;
  }>(
    `WITH cur AS (
       SELECT e.node_type, e.blob_hash, e.symlink_target, e.mode,
              e.size_bytes, e.mtime,
              -- The stored file's hash (no blob = the empty content); NULL
              -- when the path is absent, a tombstone, or not a file.
              CASE WHEN e.node_type = 'file'
                THEN COALESCE(e.blob_hash, $7) END AS stored
       FROM fs_entries e
       JOIN version_ancestors a
         ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
       WHERE e.workspace_id = $1 AND e.path = $3::ltree
         AND a.descendant_id = $2
       ORDER BY a.depth ASC
       LIMIT 1
     ),
     -- Texts are needed only when a resolver will run: the stored file is
     -- neither the base nor the incoming content, and is not a directory or
     -- symlink.
     want AS (
       SELECT $6::boolean
         AND COALESCE((SELECT node_type FROM cur), 'tombstone')
           NOT IN ('directory', 'symlink')
         AND (SELECT stored FROM cur) IS DISTINCT FROM $4::bytea
         AND (SELECT stored FROM cur) IS DISTINCT FROM $5::bytea AS texts
     )
     SELECT cur.node_type, cur.blob_hash, cur.symlink_target, cur.mode,
            cur.size_bytes, cur.mtime,
            ob.content AS ours_content, ob.binary_data AS ours_binary,
            bb.found AS base_found, bb.content AS base_content,
            bb.binary_data AS base_binary, bb.size_bytes AS base_size
     FROM want
     LEFT JOIN cur ON true
     LEFT JOIN fs_blobs ob
       ON want.texts AND cur.node_type = 'file'
      AND ob.workspace_id = $1 AND ob.hash = cur.blob_hash
     LEFT JOIN LATERAL (
       SELECT true AS found, b.content, b.binary_data, b.size_bytes
       FROM fs_blobs b
       WHERE want.texts AND $8::boolean
         AND b.workspace_id = $1 AND b.hash = $4::bytea
     ) bb ON true`,
    [
      workspaceId,
      versionId,
      pathToLtree(internal, workspaceId),
      q.baseHash,
      q.incomingHash,
      q.needTexts,
      EMPTY_CONTENT_HASH,
      q.baseFromStore,
    ],
  );
  const row = r.rows[0];
  const nodeType = row?.node_type ?? null;
  if (!row || nodeType === null || nodeType === "tombstone") {
    return {
      shape: null,
      oursText: null,
      baseFound: row?.base_found === true || blobHashEqual(q.baseHash, EMPTY_CONTENT_HASH),
      baseText: baseTextOf(row, q.baseHash),
      baseSize: Number(row?.base_size ?? 0),
    };
  }
  const shape: InternalEntryShape = {
    type: nodeType as NodeType,
    blobHash: row.blob_hash,
    symlinkTarget: row.symlink_target,
    mode: Number(row.mode ?? 0o644),
    sizeBytes: Number(row.size_bytes ?? 0),
    mtime: row.mtime ?? new Date(),
  };
  return {
    shape,
    oursText:
      nodeType === "file"
        ? row.blob_hash === null
          ? ""
          : row.ours_content !== null || row.ours_binary !== null
            ? blobText({ content: row.ours_content, binary: row.ours_binary })
            : null
        : null,
    baseFound: row.base_found === true || blobHashEqual(q.baseHash, EMPTY_CONTENT_HASH),
    baseText: baseTextOf(row, q.baseHash),
    baseSize: Number(row.base_size ?? 0),
  };
}

function baseTextOf(
  row: { base_found: boolean | null; base_content: string | null; base_binary: Uint8Array | null } | undefined,
  baseHash: Uint8Array | null,
): string | null {
  if (row?.base_found === true) {
    return blobText({ content: row.base_content, binary: row.base_binary });
  }
  // The empty content needs no stored blob.
  return blobHashEqual(baseHash, EMPTY_CONTENT_HASH) ? "" : null;
}

/**
 * Outcome of the one-statement write: a result, or why the transactional
 * path must decide. `"stale"`: another write to the version committed after
 * the statement's snapshot (retrying under the lock can still settle it).
 * `"decide"`: the snapshot already showed a mismatch, or an entry this
 * version does not own as a file (retrying cannot help).
 */
type FastOutcome =
  | { kind: "done"; result: WriteFileWithBaseResult }
  | { kind: "stale" }
  | { kind: "decide" };

/**
 * The one-statement write for a base that matches a file row this version
 * owns. It locks the version row only `WHERE xmin = <snapshot xmin>`: a write
 * that committed after the snapshot changed the row, so Postgres rechecks the
 * lock against the new row version, the xmin differs, and nothing is locked
 * or written. A real write then bumps `last_write_at`, and its inserts are
 * gated on the bump count being 1 (VERSION_LOCKED_CTE always yields its row).
 * `"unchanged"` takes the lock (to confirm the comparison) but bumps nothing.
 * A frozen version (per the snapshot; freezing is permanent) is EPERM.
 */
async function fastStatement(
  workspaceId: string,
  { client, versionId, statementTimeoutMs }: FastWriteTarget,
  internal: string,
  baseHash: Uint8Array,
  incoming: PreparedBlob,
): Promise<FastOutcome> {
  let r;
  try {
    r = await client.query<{
      status: string;
      locked: number | string;
      bumped: number | string;
    }>(
      `WITH _ws AS MATERIALIZED (
         SELECT
           set_config('app.workspace_id', $9, true) AS ws,
           set_config('statement_timeout', $10, true) AS st
         FROM ${blobGuardFrom("$9")}
       ),
       snap AS MATERIALIZED (
         SELECT v.xmin AS vx, v.frozen_at IS NOT NULL AS frozen
         FROM _ws CROSS JOIN fs_versions v
         WHERE v.workspace_id = $1 AND v.id = $2
       ),
       cur AS MATERIALIZED (
         SELECT e.node_type, COALESCE(e.blob_hash, $11) AS stored, a.depth
         FROM _ws
         CROSS JOIN fs_entries e
         JOIN version_ancestors a
           ON a.workspace_id = $1 AND a.ancestor_id = e.version_id
         WHERE e.workspace_id = $1 AND e.path = $3::ltree
           AND a.descendant_id = $2
         ORDER BY a.depth ASC
         LIMIT 1
       ),
       validation AS MATERIALIZED (
         SELECT
           CASE
             WHEN (SELECT frozen FROM snap) THEN 'frozen'
             WHEN NOT EXISTS (
               SELECT 1 FROM cur WHERE depth = 0 AND node_type = 'file'
             ) THEN 'decide'
             WHEN (SELECT stored FROM cur) = $5 THEN 'unchanged'
             WHEN (SELECT stored FROM cur) = $4 THEN 'ok'
             ELSE 'decide'
           END AS status
         FROM _ws
       ),
       version_lock AS MATERIALIZED (
         SELECT 1 FROM fs_versions
         WHERE workspace_id = $1 AND id = $2
           AND xmin = (SELECT vx FROM snap)
           AND EXISTS (
             SELECT 1 FROM validation WHERE status IN ('ok', 'unchanged')
           )
         FOR NO KEY UPDATE
       ),
       version_bump AS (
         UPDATE fs_versions SET last_write_at = now()
         WHERE workspace_id = $1 AND id = $2
           AND EXISTS (SELECT 1 FROM version_lock)
           AND EXISTS (SELECT 1 FROM validation WHERE status = 'ok')
         RETURNING 1
       ),
       ${VERSION_LOCKED_CTE},
       blob_upsert AS (
         INSERT INTO fs_blobs (workspace_id, hash, content, binary_data, size_bytes)
         SELECT $1, $5, $6, $7, $8
         FROM version_locked
         WHERE bumped = 1
         ON CONFLICT (workspace_id, hash) DO NOTHING
         RETURNING 1
       ),
       entry_update AS (
         UPDATE fs_entries e
         SET blob_hash = $5, size_bytes = $8, mtime = now()
         FROM version_locked
         WHERE bumped = 1
           AND e.workspace_id = $1 AND e.version_id = $2
           AND e.path = $3::ltree
         RETURNING 1
       )
       SELECT validation.status,
              (SELECT count(*) FROM version_lock) AS locked,
              version_locked.bumped
       FROM validation CROSS JOIN version_locked`,
      [
        workspaceId,
        versionId,
        pathToLtree(internal, workspaceId),
        baseHash,
        incoming.hash,
        incoming.text,
        incoming.binary,
        incoming.sizeBytes,
        workspaceId,
        String(statementTimeoutMs),
        EMPTY_CONTENT_HASH,
      ],
    );
  } catch (e) {
    if (e instanceof SqlError && e.code === "25006") throw readOnlyError(e);
    throw e;
  }
  const row = r.rows[0];
  const hash = bytesKey(incoming.hash);
  switch (row?.status) {
    case "frozen":
      throw frozenVersionError();
    case "ok":
      return Number(row.bumped) === 1
        ? { kind: "done", result: { outcome: "written", hash } }
        : { kind: "stale" };
    case "unchanged":
      return Number(row.locked) === 1
        ? { kind: "done", result: { outcome: "unchanged", hash } }
        : { kind: "stale" };
    default:
      return { kind: "decide" };
  }
}
