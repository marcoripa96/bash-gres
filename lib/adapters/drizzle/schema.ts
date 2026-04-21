import {
  pgTable,
  bigint,
  text,
  integer,
  timestamp,
  customType,
  uniqueIndex,
  index,
  bigserial,
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

export function createSchema(options: SchemaOptions = {}) {
  const {
    enableFullTextSearch = true,
    enableVectorSearch = false,
    embeddingDimensions,
  } = options;

  if (enableVectorSearch && !embeddingDimensions) {
    throw new Error(
      "embeddingDimensions is required when enableVectorSearch is true",
    );
  }

  return pgTable(
    "fs_nodes",
    {
      id: bigserial({ mode: "number" }).primaryKey(),
      workspaceId: text("workspace_id").notNull(),
      version: text().notNull().default("main"),
      parentId: bigint("parent_id", { mode: "number" }),
      name: text().notNull(),
      nodeType: text("node_type").notNull(),
      path: ltreeType("path").notNull(),
      content: text(),
      binaryData: byteaType("binary_data"),
      symlinkTarget: text("symlink_target"),
      mode: integer().notNull().default(420),
      sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
      mtime: timestamp({ withTimezone: true }).notNull().defaultNow(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      ...(enableVectorSearch && embeddingDimensions
        ? { embedding: vector("embedding", { dimensions: embeddingDimensions }) }
        : {}),
    },
    (table) => {
      const indexes = [
        uniqueIndex("unique_workspace_version_path").on(
          table.workspaceId,
          table.version,
          table.path,
        ),

        index("idx_fs_path_gist")
          .using("gist", sql`${table.path} gist_ltree_ops(siglen=124)`),

        index("idx_fs_workspace_parent").on(table.workspaceId, table.parentId),

        index("idx_fs_stat").on(table.workspaceId, table.version, table.path),

        index("idx_fs_dir_lookup")
          .on(table.workspaceId, table.name, table.parentId)
          .where(sql`${table.nodeType} = 'directory'`),
      ];

      if (enableFullTextSearch) {
        indexes.push(
          index("idx_fs_content_bm25")
            .using("bm25", table.content)
            .with({ text_config: "english" })
            .where(
              sql`${table.content} IS NOT NULL AND ${table.binaryData} IS NULL`,
            ),
        );
      }

      if (enableVectorSearch && "embedding" in table && table.embedding) {
        indexes.push(
          index("idx_fs_embedding")
            .using("hnsw", table.embedding.op("vector_cosine_ops")),
        );
      }

      return indexes;
    },
  );
}
