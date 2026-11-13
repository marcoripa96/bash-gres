import type { SqlClient, SetupOptions } from "./types.js";
import { FROZEN_VERSION_DETAIL } from "./filesystem/internals/constants.js";

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS fs_version_roots (
    id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    workspace_id  text NOT NULL CHECK (length(workspace_id) > 0),
    path          ltree NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT unique_workspace_version_root_path UNIQUE (workspace_id, path)
);

CREATE TABLE IF NOT EXISTS fs_versions (
    id                 bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    workspace_id       text NOT NULL CHECK (length(workspace_id) > 0),
    version_root_id    bigint REFERENCES fs_version_roots(id) ON DELETE RESTRICT,
    label              text NOT NULL CHECK (length(label) > 0),
    parent_version_id  bigint REFERENCES fs_versions(id) ON DELETE RESTRICT,
    created_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    last_write_at      timestamptz NOT NULL DEFAULT now(),
    frozen_at          timestamptz
);

-- Merge parents: version_id incorporates source_id (a frozen version) through
-- a full merge(). Read with parent_version_id when finding a merge base.
CREATE TABLE IF NOT EXISTS fs_version_merges (
    workspace_id  text NOT NULL CHECK (length(workspace_id) > 0),
    version_id    bigint NOT NULL,
    source_id     bigint NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, version_id, source_id)
);

CREATE TABLE IF NOT EXISTS version_ancestors (
    workspace_id   text NOT NULL,
    descendant_id  bigint NOT NULL,
    ancestor_id    bigint NOT NULL,
    depth          int NOT NULL CHECK (depth >= 0),
    PRIMARY KEY (workspace_id, descendant_id, ancestor_id)
);

CREATE TABLE IF NOT EXISTS fs_blobs (
    workspace_id  text NOT NULL CHECK (length(workspace_id) > 0),
    hash          bytea NOT NULL,
    content       text,
    binary_data   bytea,
    size_bytes    bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, hash)
);

CREATE TABLE IF NOT EXISTS fs_entries (
    workspace_id    text NOT NULL CHECK (length(workspace_id) > 0),
    version_id      bigint NOT NULL,
    path            ltree NOT NULL,
    blob_hash       bytea,
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink', 'tombstone')),
    symlink_target  text CHECK (symlink_target IS NULL OR length(symlink_target) <= 4096),
    mode            int NOT NULL DEFAULT 420 CHECK (mode >= 0 AND mode <= 4095),
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, version_id, path)
) WITH (fillfactor = 100);

-- Section-level slices of text blobs for chunk-granular search. Keyed by the
-- blob hash (content-addressed like fs_blobs), so an unchanged file across
-- versions/branches is never re-chunked, and search results project onto
-- visible paths the same way blob-level search does. Line ranges are
-- 1-indexed inclusive against the blob's content, so a hit is addressable as
-- path:start-end and hydratable via readFileLines(). content is the indexed
-- text (breadcrumb prefix + section body); content_hash keys future
-- embedding caching per chunk.
CREATE TABLE IF NOT EXISTS fs_blob_chunks (
    workspace_id  text NOT NULL CHECK (length(workspace_id) > 0),
    blob_hash     bytea NOT NULL,
    chunk_index   int NOT NULL CHECK (chunk_index >= 0),
    start_line    int NOT NULL CHECK (start_line >= 1),
    end_line      int NOT NULL CHECK (end_line >= start_line),
    heading_path  text,
    content       text NOT NULL,
    content_hash  bytea NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, blob_hash, chunk_index),
    CONSTRAINT fs_blob_chunks_blob_fkey FOREIGN KEY (workspace_id, blob_hash)
      REFERENCES fs_blobs(workspace_id, hash) ON DELETE CASCADE
);
`;

const MIGRATIONS_DDL = `
DO $$ BEGIN
  ALTER TABLE fs_versions ADD COLUMN version_root_id bigint;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE fs_versions ADD COLUMN deleted_at timestamptz;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE fs_versions
    ADD CONSTRAINT fs_versions_version_root_id_fkey
    FOREIGN KEY (version_root_id) REFERENCES fs_version_roots(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

ALTER TABLE fs_versions DROP CONSTRAINT IF EXISTS unique_workspace_version_label;
DROP INDEX IF EXISTS unique_workspace_version_root_label;
DROP INDEX IF EXISTS idx_fs_versions_parent;

INSERT INTO fs_version_roots (workspace_id, path)
SELECT DISTINCT ON (workspace_id) workspace_id, path
FROM fs_entries
WHERE nlevel(path) = 1
ORDER BY workspace_id, path::text
ON CONFLICT (workspace_id, path) DO NOTHING;

UPDATE fs_versions v
SET version_root_id = r.id
FROM fs_version_roots r
WHERE v.version_root_id IS NULL
  AND r.workspace_id = v.workspace_id
  AND nlevel(r.path) = 1;

-- Add last_write_at as nullable so the backfill can distinguish unmigrated
-- rows from rows already written under the new code path. Backfill from
-- MAX(mtime) of entries written directly into each version_id; fall back to
-- created_at for COW branches that have no direct entries yet. Then tighten
-- to NOT NULL with a default of now() for future inserts.
DO $$ BEGIN
  ALTER TABLE fs_versions ADD COLUMN last_write_at timestamptz;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;

UPDATE fs_versions v
SET last_write_at = COALESCE(m.max_mtime, v.created_at)
FROM (
  SELECT version_id, MAX(mtime) AS max_mtime
  FROM fs_entries
  GROUP BY version_id
) m
WHERE v.last_write_at IS NULL AND m.version_id = v.id;

UPDATE fs_versions
SET last_write_at = created_at
WHERE last_write_at IS NULL;

ALTER TABLE fs_versions ALTER COLUMN last_write_at SET DEFAULT now();
ALTER TABLE fs_versions ALTER COLUMN last_write_at SET NOT NULL;

ALTER TABLE fs_versions ADD COLUMN IF NOT EXISTS frozen_at timestamptz;
`;

/**
 * Frozen versions refuse content writes. Every write path bumps
 * fs_versions.last_write_at in the statement or transaction that writes
 * fs_entries, so refusing that bump on a frozen row rolls the write back,
 * whichever handle (or bash-gres version) issued it. SQLSTATE 25006
 * (read_only_sql_transaction) surfaces as FsError EPERM. Unfrozen rows pay
 * only the WHEN test.
 */
const FROZEN_GUARD_BODY = `
BEGIN
  RAISE EXCEPTION 'version % is frozen', OLD.id
    USING ERRCODE = '25006', DETAIL = '${FROZEN_VERSION_DETAIL}';
END
`;

export const FREEZE_TRIGGER_DDL = `
-- Replace the function only when it is missing or differs, so concurrent
-- setup() runs don't race on CREATE OR REPLACE ("tuple concurrently updated").
DO $do$ BEGIN
  IF (
    SELECT prosrc FROM pg_proc
    WHERE oid = to_regprocedure('fs_versions_refuse_frozen_write()')
  ) IS DISTINCT FROM $src$${FROZEN_GUARD_BODY}$src$ THEN
    CREATE OR REPLACE FUNCTION fs_versions_refuse_frozen_write() RETURNS trigger
    LANGUAGE plpgsql AS $fn$${FROZEN_GUARD_BODY}$fn$;
  END IF;
END $do$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'fs_versions_frozen_guard'
      AND tgrelid = 'fs_versions'::regclass
  ) THEN
    CREATE TRIGGER fs_versions_frozen_guard
      BEFORE UPDATE OF last_write_at ON fs_versions
      FOR EACH ROW WHEN (OLD.frozen_at IS NOT NULL)
      EXECUTE FUNCTION fs_versions_refuse_frozen_write();
  END IF;
END $$;
`;

const INDEXES_DDL = `
-- Version roots by mount path
CREATE INDEX IF NOT EXISTS idx_fs_version_roots_path_gist
  ON fs_version_roots USING GIST (path gist_ltree_ops(siglen=124));

-- Version labels are unique within a version root, not the whole workspace
CREATE UNIQUE INDEX IF NOT EXISTS unique_workspace_version_root_label
  ON fs_versions (workspace_id, version_root_id, label)
  WHERE version_root_id IS NOT NULL AND deleted_at IS NULL;

-- Visibility lookup: per-workspace, per-path, ordered by version
CREATE INDEX IF NOT EXISTS idx_fs_entries_path_version
  ON fs_entries (workspace_id, path, version_id);

-- ltree subtree scans (directory listing, walk, glob)
CREATE INDEX IF NOT EXISTS idx_fs_entries_path_gist
  ON fs_entries USING GIST (path gist_ltree_ops(siglen=124));

-- GC anti-join: "is this blob still referenced anywhere?"
CREATE INDEX IF NOT EXISTS idx_fs_entries_blob_hash
  ON fs_entries (workspace_id, blob_hash) WHERE blob_hash IS NOT NULL;

-- Closure: ordered nearest-ancestor scan with ancestor_id available from the index
CREATE INDEX IF NOT EXISTS idx_version_ancestors_depth_cover
  ON version_ancestors (workspace_id, descendant_id, depth, ancestor_id);

-- Closure reverse: descendants of a version (refusal checks, subtree delete)
CREATE INDEX IF NOT EXISTS idx_version_ancestors_reverse
  ON version_ancestors (workspace_id, ancestor_id);

-- Merge records by source (cleanup when a source version is removed)
CREATE INDEX IF NOT EXISTS idx_fs_version_merges_source
  ON fs_version_merges (workspace_id, source_id);

-- Versions by parent (descendant-existence checks)
CREATE INDEX IF NOT EXISTS idx_fs_versions_parent
  ON fs_versions (workspace_id, version_root_id, parent_version_id);
`;

const FTS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_fs_blob_chunks_content_bm25
  ON fs_blob_chunks USING bm25 (content)
  WITH (text_config = 'english');
`;

function rlsDdl(table: string): string {
  return `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = '${table}' AND policyname = 'workspace_isolation'
    ) THEN
        CREATE POLICY workspace_isolation ON ${table} FOR ALL
            USING (workspace_id = current_setting('app.workspace_id', true))
            WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
    END IF;
END $$;
`;
}

function vectorDDL(dimensions: number): string {
  return `
-- Per-content embedding cache for chunk-level semantic search. Keyed by the
-- chunk content hash and deliberately WITHOUT an FK to fs_blob_chunks: the
-- cache outlives its chunk rows, so re-crawled or reverted content still
-- cache-hits, and identical sections across pages share one vector (a
-- single HNSW entry per unique content). Populated by an explicit
-- indexChunkEmbeddings() pass, never by the write path.
CREATE TABLE IF NOT EXISTS fs_chunk_embeddings (
    workspace_id  text NOT NULL CHECK (length(workspace_id) > 0),
    content_hash  bytea NOT NULL,
    embedding     vector(${dimensions}) NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_fs_chunk_embeddings_hnsw ON fs_chunk_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
`;
}

/**
 * `setup()` may run from several connections at once (every process of a
 * deployment calling it at boot). Its batches take table locks one after
 * another (a backfill UPDATE, then ALTER TABLE on the same table), so two
 * sessions inside the same batch can each hold the weaker lock and wait for
 * the stronger one: a deadlock. Every batch therefore starts by taking this
 * transaction-level advisory lock, which lets one session through at a
 * time. A batch sent without parameters is one implicit transaction, so the
 * lock is held for that batch and released with it; inside a caller's own
 * transaction it is held until that transaction ends. The single-bigint key
 * is a different lock space from the (hashtext(workspace), id) pairs the
 * filesystem takes.
 */
const SETUP_LOCK_KEY = "4847322071985493";
const SETUP_LOCK = `DO $$ BEGIN PERFORM pg_advisory_xact_lock(${SETUP_LOCK_KEY}); END $$;\n`;

async function ddl(client: SqlClient, text: string): Promise<void> {
  await client.query(SETUP_LOCK + text);
}

export async function setup(
  db: SqlClient,
  options: SetupOptions = {},
): Promise<void> {
  const client = db;
  const {
    enableRLS = true,
    enableFullTextSearch = true,
    enableVectorSearch = false,
    embeddingDimensions,
    skipExtensions = false,
  } = options;

  if (enableVectorSearch && !embeddingDimensions) {
    throw new Error(
      "embeddingDimensions is required when enableVectorSearch is true",
    );
  }

  if (!skipExtensions) {
    await ddl(client, "CREATE EXTENSION IF NOT EXISTS ltree");
    if (enableFullTextSearch) {
      await ddl(client, "CREATE EXTENSION IF NOT EXISTS pg_textsearch");
    }
    if (enableVectorSearch) {
      await ddl(client, "CREATE EXTENSION IF NOT EXISTS vector");
    }
  }

  await ddl(client, TABLE_DDL);
  await ddl(client, MIGRATIONS_DDL);
  await ddl(client, FREEZE_TRIGGER_DDL);
  await ddl(client, INDEXES_DDL);

  if (enableFullTextSearch) {
    await ddl(client, FTS_INDEX_DDL);
  }

  if (enableRLS) {
    for (const table of ["fs_version_roots", "fs_versions", "version_ancestors", "fs_version_merges", "fs_entries", "fs_blobs", "fs_blob_chunks"]) {
      await ddl(client, rlsDdl(table));
    }
  }

  if (enableVectorSearch && embeddingDimensions) {
    await ddl(client, vectorDDL(embeddingDimensions));
    if (enableRLS) {
      // fs_chunk_embeddings only exists under vector search, so its RLS
      // rides here instead of the main table loop.
      await ddl(client, rlsDdl("fs_chunk_embeddings"));
    }
  }
}
