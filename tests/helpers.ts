import postgres from "postgres";
import { createPostgresClient } from "../src/adapters/postgres/index.js";
import type { SqlClient } from "../src/core/types.js";

// Re-export for convenience
export type { SqlClient };

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

export function createTestSql(): postgres.Sql {
  return postgres(TEST_DB_URL, { onnotice: () => {} });
}

export function createTestClient(): { sql: postgres.Sql; client: SqlClient } {
  const sql = createTestSql();
  const client = createPostgresClient(sql);
  return { sql, client };
}

export async function resetDb(client: SqlClient): Promise<void> {
  await client.query("TRUNCATE fs_nodes CASCADE");
}
