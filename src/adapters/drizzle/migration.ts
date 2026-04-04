export interface MigrationOptions {
  enableRLS?: boolean;
  enableFullTextSearch?: boolean;
  enableVectorSearch?: boolean;
}

/**
 * Returns SQL for a custom Drizzle migration covering what `createSchema()`
 * cannot express: extensions and RLS policies.
 *
 * The table and indexes are handled by the Drizzle schema (`createSchema()`),
 * so `drizzle-kit generate` picks those up automatically. This function
 * produces the SQL for everything else.
 *
 * @example
 * ```ts
 * import { generateMigrationSQL } from "bash-gres/drizzle";
 * console.log(generateMigrationSQL());
 * // Paste into a custom migration: drizzle-kit generate --custom
 * ```
 */
export function generateMigrationSQL(options: MigrationOptions = {}): string {
  const {
    enableRLS = true,
    enableFullTextSearch = true,
    enableVectorSearch = false,
  } = options;

  const parts: string[] = [];

  parts.push("CREATE EXTENSION IF NOT EXISTS ltree;");

  if (enableFullTextSearch) {
    parts.push("CREATE EXTENSION IF NOT EXISTS pg_textsearch;");
  }

  if (enableVectorSearch) {
    parts.push("CREATE EXTENSION IF NOT EXISTS vector;");
  }

  if (enableRLS) {
    parts.push(`
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
END $$;`);
  }

  return parts.join("\n");
}
