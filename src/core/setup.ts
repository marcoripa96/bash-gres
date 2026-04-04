import type { SqlClient, SetupOptions } from "./types.js";

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS fs_nodes (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    workspace_id      text NOT NULL CHECK (length(workspace_id) > 0),
    parent_id       bigint REFERENCES fs_nodes(id) ON DELETE RESTRICT,
    name            text NOT NULL CHECK (length(name) <= 255),
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink')),
    path            ltree NOT NULL,
    content         text,
    binary_data     bytea,
    symlink_target  text CHECK (symlink_target IS NULL OR length(symlink_target) <= 4096),
    mode            int NOT NULL DEFAULT 420 CHECK (mode >= 0 AND mode <= 4095),
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT unique_workspace_path UNIQUE (workspace_id, path)
);
`;

const INDEXES_DDL = `
CREATE INDEX IF NOT EXISTS idx_fs_path_gist
  ON fs_nodes USING GIST (path gist_ltree_ops(siglen=124));

CREATE INDEX IF NOT EXISTS idx_fs_workspace_parent
  ON fs_nodes (workspace_id, parent_id);

CREATE INDEX IF NOT EXISTS idx_fs_stat
  ON fs_nodes (workspace_id, path)
  INCLUDE (node_type, mode, size_bytes, mtime);

CREATE INDEX IF NOT EXISTS idx_fs_dir_lookup
  ON fs_nodes (workspace_id, name, parent_id)
  WHERE node_type = 'directory';
`;

const FTS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_fs_content_bm25
  ON fs_nodes USING bm25 (name, content)
  WITH (text_config = 'english')
  WHERE content IS NOT NULL AND binary_data IS NULL;
`;

const RLS_DDL = `
ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_nodes FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'fs_nodes' AND policyname = 'workspace_isolation'
    ) THEN
        CREATE POLICY workspace_isolation ON fs_nodes FOR ALL
            USING (workspace_id = current_setting('app.workspace_id', true))
            WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
    END IF;
END $$;
`;

function vectorDDL(dimensions: number): string {
  return `
    DO $$ BEGIN
      ALTER TABLE fs_nodes ADD COLUMN embedding vector(${dimensions});
    EXCEPTION WHEN duplicate_column THEN
      NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_fs_embedding ON fs_nodes
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
  await client.query(INDEXES_DDL);

  if (enableFullTextSearch) {
    await client.query(FTS_INDEX_DDL);
  }

  if (enableRLS) {
    await client.query(RLS_DDL);
  }

  if (enableVectorSearch && embeddingDimensions) {
    await client.query(vectorDDL(embeddingDimensions));
  }
}
