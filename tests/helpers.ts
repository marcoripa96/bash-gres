import postgres from "postgres";
import pg from "pg";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { createDrizzleClient } from "../lib/adapters/drizzle/adapter.js";
import { createNodePgClient } from "../lib/adapters/node-postgres/index.js";
import type { SqlClient } from "../lib/core/types.js";

// Re-export for convenience
export type { SqlClient };

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

export interface TestClient {
  client: SqlClient;
  teardown: () => Promise<void>;
}

export function createTestSql(): postgres.Sql {
  return postgres(TEST_DB_URL, { onnotice: () => {} });
}

function createPostgresTestClient(): TestClient {
  const sql = createTestSql();
  const client = createPostgresClient(sql);
  return { client, teardown: () => sql.end() };
}

function createDrizzleTestClient(): TestClient {
  const sql = postgres(TEST_DB_URL, { onnotice: () => {} });
  const db = drizzle(sql);
  const client = createDrizzleClient(db);
  return { client, teardown: () => sql.end() };
}

function createNodePgTestClient(): TestClient {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  const client = createNodePgClient(pool);
  return { client, teardown: () => pool.end() };
}

/** @deprecated Use TEST_ADAPTERS with describe.each instead */
export function createTestClient(): { sql: postgres.Sql; client: SqlClient } {
  const sql = createTestSql();
  const client = createPostgresClient(sql);
  return { sql, client };
}

export async function resetDb(client: SqlClient): Promise<void> {
  await client.query("TRUNCATE fs_nodes CASCADE");
}

export type AdapterFactory = () => TestClient;

export const TEST_ADAPTERS: [string, AdapterFactory][] = [
  ["postgres", createPostgresTestClient],
  ["drizzle", createDrizzleTestClient],
  ["node-postgres", createNodePgTestClient],
];
