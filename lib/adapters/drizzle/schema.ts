import {
  pgTable,
  bigint,
  bigserial,
  text,
  integer,
  timestamp,
  customType,
  uniqueIndex,
  index,
  primaryKey,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ltreeType = customType<{ data: string }>({
  dataType() {
    return "ltree";
  },
});

const byteaType = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export interface SchemaOptions {
  enableFullTextSearch?: boolean;
  enableVectorSearch?: boolean;
  embeddingDimensions?: number;
}

export interface BashGresSchema {
  fsVersionRoots: ReturnType<typeof buildVersionRoots>;
  fsVersions: ReturnType<typeof buildVersions>;
  versionAncestors: ReturnType<typeof buildAncestors>;
  fsBlobs: ReturnType<typeof buildBlobs>;
  fsEntries: ReturnType<typeof buildEntries>;
  fsBlobChunks: ReturnType<typeof buildBlobChunks>;
}

/** The schema when vector search is on: the `fs_chunk_embeddings` cache
 *  table exists, concretely typed. */
export interface BashGresSchemaWithVector extends BashGresSchema {
  fsChunkEmbeddings: ReturnType<typeof buildChunkEmbeddings>;
}

function buildVersionRoots() {
  return pgTable(
    "fs_version_roots",
    {
      id: bigserial({ mode: "number" }).primaryKey(),
      workspaceId: text("workspace_id").notNull(),
      path: ltreeType("path").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      uniqueIndex("unique_workspace_version_root_path").on(
        table.workspaceId,
        table.path,
      ),
      index("idx_fs_version_roots_path_gist").using(
        "gist",
        sql`${table.path} gist_ltree_ops(siglen=124)`,
      ),
    ],
  );
}

function buildVersions() {
  return pgTable(
    "fs_versions",
    {
      id: bigserial({ mode: "number" }).primaryKey(),
      workspaceId: text("workspace_id").notNull(),
      versionRootId: bigint("version_root_id", { mode: "number" }),
      label: text().notNull(),
      parentVersionId: bigint("parent_version_id", { mode: "number" }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      lastWriteAt: timestamp("last_write_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      uniqueIndex("unique_workspace_version_root_label")
        .on(table.workspaceId, table.versionRootId, table.label)
        .where(sql`${table.versionRootId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
      index("idx_fs_versions_parent").on(
        table.workspaceId,
        table.versionRootId,
        table.parentVersionId,
      ),
    ],
  );
}

function buildAncestors() {
  return pgTable(
    "version_ancestors",
    {
      workspaceId: text("workspace_id").notNull(),
      descendantId: bigint("descendant_id", { mode: "number" }).notNull(),
      ancestorId: bigint("ancestor_id", { mode: "number" }).notNull(),
      depth: integer().notNull(),
    },
    (table) => [
      primaryKey({
        columns: [table.workspaceId, table.descendantId, table.ancestorId],
      }),
      index("idx_version_ancestors_depth_cover").on(
        table.workspaceId,
        table.descendantId,
        table.depth,
        table.ancestorId,
      ),
      index("idx_version_ancestors_reverse").on(
        table.workspaceId,
        table.ancestorId,
      ),
    ],
  );
}

function buildBlobs() {
  return pgTable(
    "fs_blobs",
    {
      workspaceId: text("workspace_id").notNull(),
      hash: byteaType("hash").notNull(),
      content: text(),
      binaryData: byteaType("binary_data"),
      sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.workspaceId, table.hash] })],
  );
}

// Section-level slices of text blobs for chunk-granular search; content-
// addressed like fs_blobs (see lib/core/setup.ts for the column semantics).
// The FK to fs_blobs is declared in the core DDL only — this schema mirrors
// tables for query typing, and no table here declares FKs.
function buildBlobChunks(options: SchemaOptions) {
  const { enableFullTextSearch = true } = options;
  return pgTable(
    "fs_blob_chunks",
    {
      workspaceId: text("workspace_id").notNull(),
      blobHash: byteaType("blob_hash").notNull(),
      chunkIndex: integer("chunk_index").notNull(),
      startLine: integer("start_line").notNull(),
      endLine: integer("end_line").notNull(),
      headingPath: text("heading_path"),
      content: text().notNull(),
      contentHash: byteaType("content_hash").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => {
      const indexes: unknown[] = [
        primaryKey({
          columns: [table.workspaceId, table.blobHash, table.chunkIndex],
        }),
      ];
      if (enableFullTextSearch) {
        indexes.push(
          index("idx_fs_blob_chunks_content_bm25")
            .using("bm25", table.content)
            .with({ text_config: "english" }),
        );
      }
      return indexes as ReturnType<typeof index>[];
    },
  );
}

// Per-content embedding cache for chunk-level semantic search. Deliberately
// no FK to fs_blob_chunks — the cache outlives its chunk rows (see
// lib/core/setup.ts for the semantics).
function buildChunkEmbeddings(embeddingDimensions: number) {
  return pgTable(
    "fs_chunk_embeddings",
    {
      workspaceId: text("workspace_id").notNull(),
      contentHash: byteaType("content_hash").notNull(),
      embedding: vector("embedding", {
        dimensions: embeddingDimensions,
      }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({ columns: [table.workspaceId, table.contentHash] }),
      index("idx_fs_chunk_embeddings_hnsw").using(
        "hnsw",
        table.embedding.op("vector_cosine_ops"),
      ),
    ],
  );
}

function buildEntries() {
  return pgTable(
    "fs_entries",
    {
      workspaceId: text("workspace_id").notNull(),
      versionId: bigint("version_id", { mode: "number" }).notNull(),
      path: ltreeType("path").notNull(),
      blobHash: byteaType("blob_hash"),
      nodeType: text("node_type").notNull(),
      symlinkTarget: text("symlink_target"),
      mode: integer().notNull().default(420),
      sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
      mtime: timestamp({ withTimezone: true }).notNull().defaultNow(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        columns: [table.workspaceId, table.versionId, table.path],
      }),
      index("idx_fs_entries_path_version").on(
        table.workspaceId,
        table.path,
        table.versionId,
      ),
      index("idx_fs_entries_path_gist").using(
        "gist",
        sql`${table.path} gist_ltree_ops(siglen=124)`,
      ),
      index("idx_fs_entries_blob_hash")
        .on(table.workspaceId, table.blobHash)
        .where(sql`${table.blobHash} IS NOT NULL`),
    ],
  );
}

export function createSchema(
  options: SchemaOptions & { enableVectorSearch: true },
): BashGresSchemaWithVector;
export function createSchema(options?: SchemaOptions): BashGresSchema;
export function createSchema(
  options: SchemaOptions = {},
): BashGresSchema | BashGresSchemaWithVector {
  const { enableVectorSearch = false, embeddingDimensions } = options;

  if (enableVectorSearch && !embeddingDimensions) {
    throw new Error(
      "embeddingDimensions is required when enableVectorSearch is true",
    );
  }

  const base = {
    fsVersionRoots: buildVersionRoots(),
    fsVersions: buildVersions(),
    versionAncestors: buildAncestors(),
    fsBlobs: buildBlobs(),
    fsEntries: buildEntries(),
    fsBlobChunks: buildBlobChunks(options),
  };
  if (enableVectorSearch && embeddingDimensions) {
    return { ...base, fsChunkEmbeddings: buildChunkEmbeddings(embeddingDimensions) };
  }
  return base;
}
