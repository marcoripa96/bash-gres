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

export const fsNodes = pgTable(
  "fs_nodes",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
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
  },
  (table) => [
    // Unique session + path constraint
    uniqueIndex("unique_session_path").on(table.sessionId, table.path),

    // GiST index on ltree path for hierarchy queries (<@, @>, etc.)
    index("idx_fs_path_gist")
      .using("gist", sql`${table.path} gist_ltree_ops(siglen=124)`),

    // B-tree for direct-child lookups (readdir via parent_id)
    index("idx_fs_session_parent").on(table.sessionId, table.parentId),

    // Covering index for stat-like lookups
    index("idx_fs_stat").on(table.sessionId, table.path),

    // Partial index for mkdir existence checks
    index("idx_fs_dir_lookup")
      .on(table.sessionId, table.name, table.parentId)
      .where(sql`${table.nodeType} = 'directory'`),

    // BM25 full-text search via pg_textsearch
    index("idx_fs_content_bm25")
      .using("bm25", table.name, table.content)
      .with({ text_config: "english" })
      .where(
        sql`${table.content} IS NOT NULL AND ${table.binaryData} IS NULL`,
      ),
  ],
);
