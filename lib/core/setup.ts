import type { SqlClient, SetupOptions } from "./types.js";

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
    last_write_at      timestamptz NOT NULL DEFAULT now()
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

-- Versions by parent (descendant-existence checks)
CREATE INDEX IF NOT EXISTS idx_fs_versions_parent
  ON fs_versions (workspace_id, version_root_id, parent_version_id);
`;

const FTS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_fs_blobs_content_bm25
  ON fs_blobs USING bm25 (content)
  WITH (text_config = 'english')
  WHERE content IS NOT NULL AND binary_data IS NULL;

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
DO $$ BEGIN
  ALTER TABLE fs_blobs ADD COLUMN embedding vector(${dimensions});
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_fs_blobs_embedding ON fs_blobs
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
`;
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
    await client.query("CREATE EXTENSION IF NOT EXISTS ltree");
    if (enableFullTextSearch) {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_textsearch");
    }
    if (enableVectorSearch) {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    }
  }

  await client.query(TABLE_DDL);
  await client.query(MIGRATIONS_DDL);
  await client.query(INDEXES_DDL);

  if (enableFullTextSearch) {
    await client.query(FTS_INDEX_DDL);
  }

  if (enableRLS) {
    for (const table of ["fs_version_roots", "fs_versions", "version_ancestors", "fs_entries", "fs_blobs", "fs_blob_chunks"]) {
      await client.query(rlsDdl(table));
    }
  }

  if (enableVectorSearch && embeddingDimensions) {
    await client.query(vectorDDL(embeddingDimensions));
  }
}
