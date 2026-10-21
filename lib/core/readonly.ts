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
const READ_START = /^[\s;(]*(WITH|SELECT)\b/i;
const WRITE_CAPABLE =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|CALL|DO|LOCK|INTO|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|SECURITY|IMPORT|LISTEN|NOTIFY|PREPARE|EXECUTE|DEALLOCATE|SET|RESET|DISCARD|SHARE)\b|\b(nextval|setval|set_config|lo_\w+|pg_\w+|dblink\w*)\s*\(/i;

/**
 * True only for a statement that can't write when run on its own: it starts
 * with SELECT/WITH and mentions no write-capable keyword or side-effecting
 * function. Deliberately over-broad: a read it misclassifies just keeps the
 * read-only transaction, so the check can only cost speed, never safety.
 * Read-only instances run statements that pass it as one implicit
 * transaction instead of BEGIN / SET TRANSACTION READ ONLY / query / COMMIT.
 */
export function isPlainRead(text: string): boolean {
  return READ_START.test(text) && !WRITE_CAPABLE.test(text);
}

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
