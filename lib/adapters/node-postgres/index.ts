import type { SqlClient, QueryResult, SqlParam, SetupOptions, PgFileSystemOptions } from "../../core/types.js";
import { SqlError } from "../../core/types.js";
import { PgFileSystem as CorePgFileSystem } from "../../core/filesystem.js";
import { setup as coreSetup } from "../../core/setup.js";

export { FsQuotaError } from "../../core/types.js";
export type { WorkspaceUsage, WorkspaceUsageOptions } from "../../core/types.js";

/**
 * Structural interface matching `pg.PoolClient`.
 * Keeps `pg` as a peer dep: no direct import required.
 */
export interface NodePgPoolClient {
  query(text: string, values?: unknown[]): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
  release(err?: Error | boolean): void;
}

/**
 * Structural interface matching `pg.Pool`.
 */
export interface NodePgPool {
  query(text: string, values?: unknown[]): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
  connect(): Promise<NodePgPoolClient>;
}

// -- Internal helpers ---------------------------------------------------------

let nextSavepointId = 0;

/**
 * Wrap a PoolClient (already inside a transaction) into a SqlClient.
 * Nested `transaction()` calls use SAVEPOINTs.
 */
function wrapPoolClient(poolClient: NodePgPoolClient): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        const result = await poolClient.query(text, params as unknown[]);
        return {
          rows: result.rows as T[],
          rowCount: result.rowCount,
        };
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      const sp = `sp_${++nextSavepointId}`;
      await poolClient.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn(wrapPoolClient(poolClient));
        await poolClient.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (e: unknown) {
        try {
          await poolClient.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        } catch {
          // ignore rollback errors
        }
        throw e;
      }
    },
  };
}

/**
 * Creates a SqlClient backed by a node-postgres Pool.
 *
 * @example
 * ```ts
 * import pg from "pg";
 * import { createNodePgClient } from "bash-gres/node-postgres";
 *
 * const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/mydb" });
 * const client = createNodePgClient(pool);
 * ```
 */
export function createNodePgClient(pool: NodePgPool): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        const result = await pool.query(text, params as unknown[]);
        return {
          rows: result.rows as T[],
          rowCount: result.rowCount,
        };
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      const poolClient = await pool.connect();
      try {
        await poolClient.query("BEGIN");
        const result = await fn(wrapPoolClient(poolClient));
        await poolClient.query("COMMIT");
        return result;
      } catch (e: unknown) {
        try {
          await poolClient.query("ROLLBACK");
        } catch {
          // ignore rollback errors
        }
        throw e;
      } finally {
        poolClient.release();
      }
    },
  };
}

// -- setup (node-postgres-native) ---------------------------------------------

/**
 * node-postgres-native setup: accepts a `pg.Pool` instance directly.
 *
 * @example
 * ```ts
 * import pg from "pg";
 * import { setup } from "bash-gres/node-postgres";
 *
 * const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/mydb" });
 * await setup(pool);
 * ```
 */
export function setup(pool: NodePgPool, options?: SetupOptions): Promise<void> {
  return coreSetup(createNodePgClient(pool), options);
}

// -- PgFileSystem (node-postgres-native) --------------------------------------

export type NodePgFileSystemOptions = Omit<PgFileSystemOptions, "db"> & {
  db: NodePgPool;
};

/**
 * PgFileSystem that accepts a `pg.Pool` instance directly.
 *
 * @example
 * ```ts
 * import pg from "pg";
 * import { PgFileSystem } from "bash-gres/node-postgres";
 *
 * const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/mydb" });
 * const fs = new PgFileSystem({ db: pool, workspaceId: "ws-1" });
 * ```
 */
export class PgFileSystem extends CorePgFileSystem {
  constructor(options: NodePgFileSystemOptions) {
    super({ ...options, db: createNodePgClient(options.db) });
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
