import type { SqlClient, QueryResult, SqlParam, SetupOptions, PgFileSystemOptions } from "../../core/types.js";
import { SqlError } from "../../core/types.js";
import { PgFileSystem as CorePgFileSystem } from "../../core/filesystem.js";
import { setup as coreSetup } from "../../core/setup.js";
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

// -- setup (postgres.js-native) -----------------------------------------------

/**
 * postgres.js-native setup — accepts a postgres.js `sql` instance directly.
 *
 * @example
 * ```ts
 * import postgres from "postgres";
 * import { setup } from "bash-gres/postgres";
 *
 * const sql = postgres("postgres://localhost:5432/mydb");
 * await setup(sql);
 * ```
 */
export function setup<TTypes extends Record<string, unknown> = Record<string, unknown>>(
  sql: postgres.Sql<TTypes>,
  options?: SetupOptions,
): Promise<void> {
  return coreSetup(createPostgresClient(sql), options);
}

// -- PgFileSystem (postgres.js-native) ----------------------------------------

export type PostgresPgFileSystemOptions<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  Omit<PgFileSystemOptions, "db"> & { db: postgres.Sql<TTypes> };

/**
 * PgFileSystem that accepts a postgres.js `sql` instance directly.
 *
 * @example
 * ```ts
 * import postgres from "postgres";
 * import { PgFileSystem } from "bash-gres/postgres";
 *
 * const sql = postgres("postgres://localhost:5432/mydb");
 * const fs = new PgFileSystem({ db: sql, workspaceId: "ws-1" });
 * ```
 */
export class PgFileSystem extends CorePgFileSystem {
  constructor(options: PostgresPgFileSystemOptions) {
    super({ ...options, db: createPostgresClient(options.db) });
  }
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
