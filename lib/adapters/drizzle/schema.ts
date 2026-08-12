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

/** The schema when vector search is on: `fs_blobs` carries the `embedding`
 *  column, concretely typed. */
export interface BashGresSchemaWithVector
  extends Omit<BashGresSchema, "fsBlobs"> {
  fsBlobs: ReturnType<typeof buildBlobsWithEmbedding>;
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

// The blob columns and indexes are shared by the two `fs_blobs` builders
// below. Two separate builders — instead of one with a conditional spread —
// keep each table's column set statically known: a conditional spread infers
// `embedding` as an *optional* column, which violates Drizzle's
// `Record<string, PgColumn>` table constraint and breaks `db.select()`/
// `db.delete()` typing for every consumer of the schema.
function blobColumns() {
  return {
    workspaceId: text("workspace_id").notNull(),
    hash: byteaType("hash").notNull(),
    content: text(),
    binaryData: byteaType("binary_data"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}

function buildBlobs(options: SchemaOptions) {
  const { enableFullTextSearch = true } = options;
  return pgTable("fs_blobs", blobColumns(), (table) => {
    const indexes: unknown[] = [
      primaryKey({ columns: [table.workspaceId, table.hash] }),
    ];
    if (enableFullTextSearch) {
      indexes.push(
        index("idx_fs_blobs_content_bm25")
          .using("bm25", table.content)
          .with({ text_config: "english" })
          .where(
            sql`${table.content} IS NOT NULL AND ${table.binaryData} IS NULL`,
          ),
      );
    }
    return indexes as ReturnType<typeof index>[];
  });
}

function buildBlobsWithEmbedding(
  options: SchemaOptions,
  embeddingDimensions: number,
) {
  const { enableFullTextSearch = true } = options;
  return pgTable(
    "fs_blobs",
    {
      ...blobColumns(),
      embedding: vector("embedding", { dimensions: embeddingDimensions }),
    },
    (table) => {
      const indexes: unknown[] = [
        primaryKey({ columns: [table.workspaceId, table.hash] }),
      ];
      if (enableFullTextSearch) {
        indexes.push(
          index("idx_fs_blobs_content_bm25")
            .using("bm25", table.content)
            .with({ text_config: "english" })
            .where(
              sql`${table.content} IS NOT NULL AND ${table.binaryData} IS NULL`,
            ),
        );
      }
      indexes.push(
        index("idx_fs_blobs_embedding").using(
          "hnsw",
          table.embedding.op("vector_cosine_ops"),
        ),
      );
      return indexes as ReturnType<typeof index>[];
    },
  );
}

// Section-level slices of text blobs for chunk-granular search; content-
// addressed like fs_blobs (see lib/core/setup.ts for the column semantics).
// The FK to fs_blobs is declared in the core DDL only — this schema mirrors
// tables for query typing, and no table here declares FKs.
function buildBlobChunks() {
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
    (table) => [
      primaryKey({
        columns: [table.workspaceId, table.blobHash, table.chunkIndex],
      }),
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

  return {
    fsVersionRoots: buildVersionRoots(),
    fsVersions: buildVersions(),
    versionAncestors: buildAncestors(),
    fsBlobs:
      enableVectorSearch && embeddingDimensions
        ? buildBlobsWithEmbedding(options, embeddingDimensions)
        : buildBlobs(options),
    fsEntries: buildEntries(),
    fsBlobChunks: buildBlobChunks(),
  };
}
