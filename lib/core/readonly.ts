import type { SqlClient, SqlParam, QueryResult } from "./types.js";

/**
 * Wraps a `SqlClient` so that every transaction is marked `READ ONLY`.
 * PostgreSQL will reject any INSERT / UPDATE / DELETE / DDL automatically.
 *
 * Bare `query()` calls are also wrapped in a read-only transaction as a safety net.
 *
 * **Note:** `PgFileSystem.init()` performs an INSERT to create the root node,
 * so the workspace must be initialized with a writable client first.
 *
 * @example
 * ```ts
 * const roClient = readonlySqlClient(client);
 * const fs = new PgFileSystem({ db: roClient, workspaceId });
 * // fs.readFile() works; fs.writeFile() throws SqlError (code 25006)
 * ```
 */
export function readonlySqlClient(client: SqlClient): SqlClient {
  return {
    query<T = Record<string, unknown>>(
      text: string,
      params?: SqlParam[],
    ): Promise<QueryResult<T>> {
      return client.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        return tx.query<T>(text, params);
      });
    },

    transaction<T>(fn: (inner: SqlClient) => Promise<T>): Promise<T> {
      return client.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        return fn(tx);
      });
    },
  };
}
