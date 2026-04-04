CREATE TABLE "fs_nodes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" bigint,
	"name" text NOT NULL,
	"node_type" text NOT NULL,
	"path" "ltree" NOT NULL,
	"content" text,
	"binary_data" "bytea",
	"symlink_target" text,
	"mode" integer DEFAULT 420 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"mtime" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "unique_workspace_path" ON "fs_nodes" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "idx_fs_path_gist" ON "fs_nodes" USING gist ("path" gist_ltree_ops(siglen=124));--> statement-breakpoint
CREATE INDEX "idx_fs_workspace_parent" ON "fs_nodes" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_fs_stat" ON "fs_nodes" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "idx_fs_dir_lookup" ON "fs_nodes" USING btree ("workspace_id","name","parent_id") WHERE "fs_nodes"."node_type" = 'directory';--> statement-breakpoint
CREATE INDEX "idx_fs_content_bm25" ON "fs_nodes" USING bm25 ("name","content") WITH (text_config=english) WHERE "fs_nodes"."content" IS NOT NULL AND "fs_nodes"."binary_data" IS NULL;