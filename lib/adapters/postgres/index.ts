import type { SqlClient, QueryResult, SqlParam, SetupOptions, PgFileSystemOptions } from "../../core/types.js";
import { SqlError } from "../../core/types.js";
import { PgFileSystem as CorePgFileSystem } from "../../core/filesystem.js";
import { setup as coreSetup } from "../../core/setup.js";
import type postgres from "postgres";

export { FsQuotaError } from "../../core/types.js";
export type {
  VersionDiffCountOptions,
  VersionDiffOptions,
  VersionDiffStreamOptions,
  WorkspaceUsage,
  WorkspaceUsageOptions,
} from "../../core/types.js";

export interface PostgresClientOptions {
  /**
   * Send queries as named prepared statements. Off by default.
   *
   * postgres.js runs an unprepared parameterized query as two round-trips (a
   * Describe to learn the parameter types, then the execute); a prepared one
   * is described once per connection and then takes one round-trip. Against
   * a remote database this roughly halves the latency of every filesystem
   * call, and repeated statements also skip planning.
   *
   * Leave it off behind a transaction-mode pooler that doesn't support
   * prepared statements (PgBouncer before 1.21, or without
   * `max_prepared_statements`). A connection created with
   * `postgres(url, { prepare: false })` stays unprepared either way.
   *
   * Statements binding more than 32 parameters always run unprepared: those
   * are batch inserts whose text varies with the batch size, and postgres.js
   * keeps every prepared statement for the connection's lifetime.
   */
  prepare?: boolean;
}

/** Above this, statement text is data-shaped (a VALUES batch); see `prepare`. */
const MAX_PREPARED_PARAMS = 32;

type QueryOptions = (params: SqlParam[]) => { prepare: boolean };

function queryOptionsFor(options?: PostgresClientOptions): QueryOptions {
  const prepared = { prepare: true };
  const unprepared = { prepare: false };
  if (!options?.prepare) return () => unprepared;
  return (params) =>
    params.length <= MAX_PREPARED_PARAMS ? prepared : unprepared;
}

/**
 * Wrap a postgres.js TransactionSql into a SqlClient.
 * Nested calls use SAVEPOINTs via `tx.savepoint()`.
 */
function wrapTransactionSql<TTypes extends Record<string, unknown>>(
  tx: postgres.TransactionSql<TTypes>,
  queryOptions: QueryOptions,
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
          queryOptions(params),
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
        fn(wrapTransactionSql(sp, queryOptions)),
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
 * // or, when no transaction-mode pooler sits in between:
 * const fast = createPostgresClient(sql, { prepare: true });
 * ```
 */
export function createPostgresClient<
  TTypes extends Record<string, unknown> = Record<string, unknown>,
>(sql: postgres.Sql<TTypes>, options?: PostgresClientOptions): SqlClient {
  const queryOptions = queryOptionsFor(options);
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        const result = await sql.unsafe<Record<string, unknown>[]>(
          text,
          params as postgres.SerializableParameter[],
          queryOptions(params),
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
        fn(wrapTransactionSql(tx, queryOptions)),
      );
      return result as U;
    },
  };
}

// -- setup (postgres.js-native) -----------------------------------------------

/**
 * postgres.js-native setup: accepts a postgres.js `sql` instance directly.
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
  Omit<PgFileSystemOptions, "db"> & PostgresClientOptions & { db: postgres.Sql<TTypes> };

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
 *
 * `prepare: true` opts into prepared statements (see `PostgresClientOptions`);
 * forks and `versioned()` children inherit it.
 */
export class PgFileSystem extends CorePgFileSystem {
  constructor(options: PostgresPgFileSystemOptions) {
    super({
      ...options,
      db: createPostgresClient(options.db, { prepare: options.prepare }),
    });
    // See drizzle adapter: keep the un-wrapped raw db here so child instances
    // produced by fork() / scope helpers re-wrap from the original source.
    this.rawDb = options.db;
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
