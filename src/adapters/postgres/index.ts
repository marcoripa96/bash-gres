import type { SqlClient, QueryResult, SqlParam } from "../../core/types.js";
import { SqlError } from "../../core/types.js";
import type postgres from "postgres";

/**
 * Wrap a postgres.js TransactionSql into a SqlClient.
 * Nested calls use SAVEPOINTs via `tx.savepoint()`.
 */
function wrapTransactionSql<TTypes extends Record<string, unknown>>(
  tx: postgres.TransactionSql<TTypes>,
): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        const result = await tx.unsafe<Record<string, unknown>[]>(
          text,
          params as postgres.SerializableParameter[],
        );
        return {
          rows: Array.from(result) as T[],
          rowCount: result.count,
        };
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      // postgres.js savepoint returns UnwrapPromiseArray<T>.
      // When T is non-array (our case), UnwrapPromiseArray<T> === T.
      // TypeScript cannot prove this statically, so we assert the result type.
      const result: unknown = await tx.savepoint((sp) =>
        fn(wrapTransactionSql(sp)),
      );
      return result as U;
    },
  };
}

/**
 * Creates a SqlClient backed by a postgres.js connection.
 *
 * @example
 * ```ts
 * import postgres from "postgres";
 * import { createPostgresClient } from "bash-gres/postgres";
 *
 * const sql = postgres("postgres://localhost:5432/mydb");
 * const client = createPostgresClient(sql);
 * ```
 */
export function createPostgresClient<
  TTypes extends Record<string, unknown> = Record<string, unknown>,
>(sql: postgres.Sql<TTypes>): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        const result = await sql.unsafe<Record<string, unknown>[]>(
          text,
          params as postgres.SerializableParameter[],
        );
        return {
          rows: Array.from(result) as T[],
          rowCount: result.count,
        };
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      // See comment in wrapTransactionSql.transaction for UnwrapPromiseArray justification.
      const result: unknown = await sql.begin((tx) =>
        fn(wrapTransactionSql(tx)),
      );
      return result as U;
    },
  };
}

// -- Error handling -----------------------------------------------------------

interface PgErrorShape extends Error {
  code: string;
  detail?: string;
  constraint?: string;
}

function isPgError(e: unknown): e is PgErrorShape {
  return (
    e instanceof Error &&
    "code" in e && typeof e.code === "string"
  );
}

function wrapError(e: unknown): Error {
  if (isPgError(e)) {
    return new SqlError(e.message, e.code, e.detail, e.constraint, e);
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}
