import { sql } from "drizzle-orm";
import type { SqlClient, QueryResult, SqlParam, PgFileSystemOptions, SetupOptions } from "../../core/types.js";
import { SqlError } from "../../core/types.js";
import { PgFileSystem as CorePgFileSystem } from "../../core/filesystem.js";
import { setup as coreSetup } from "../../core/setup.js";

/**
 * Structural interface for any Drizzle PG database or transaction.
 * Matches PgDatabase / PgTransaction without importing their
 * higher-kinded type parameters.
 */
export interface DrizzleDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: any): PromiseLike<unknown>;
  transaction<T>(
    transaction: (tx: DrizzleDb) => Promise<T>,
    config?: { isolationLevel?: string },
  ): Promise<T>;
  query?: unknown;
}

// -- SQL builder --------------------------------------------------------------

function pgArrayLiteral(arr: unknown[]): string {
  return (
    "{" +
    arr
      .map((v) => {
        if (v === null || v === undefined) return "NULL";
        const s = String(v);
        if (
          s === "" ||
          s.includes(",") ||
          s.includes('"') ||
          s.includes("\\") ||
          s.includes("{") ||
          s.includes("}") ||
          s.includes(" ") ||
          s.toUpperCase() === "NULL"
        ) {
          return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
        }
        return s;
      })
      .join(",") +
    "}"
  );
}

function buildQuery(text: string, params: SqlParam[]) {
  if (params.length === 0) return sql.raw(text);

  const parts = text.split(/(\$\d+)/);
  const chunks: ReturnType<typeof sql.raw>[] = [];

  for (const part of parts) {
    const match = part.match(/^\$(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < params.length) {
        const value = params[idx];
        if (Array.isArray(value)) {
          chunks.push(sql`${pgArrayLiteral(value)}`);
        } else if (value instanceof Date) {
          chunks.push(sql`${value.toISOString()}`);
        } else {
          chunks.push(sql`${value}`);
        }
      } else {
        chunks.push(sql.raw(part));
      }
    } else if (part) {
      chunks.push(sql.raw(part));
    }
  }

  return sql.join(chunks, sql.raw(""));
}

// -- Result normalization -----------------------------------------------------

interface ArrayWithCount extends Array<unknown> {
  count: number;
}

function normalizeResult<T>(result: unknown): QueryResult<T> {
  if (Array.isArray(result)) {
    return {
      rows: result as T[],
      rowCount:
        typeof (result as ArrayWithCount).count === "number"
          ? (result as ArrayWithCount).count
          : null,
    };
  }
  if (result !== null && typeof result === "object" && "rows" in result) {
    const shaped = result as { rows: unknown[]; rowCount?: number | null };
    return {
      rows: shaped.rows as T[],
      rowCount: shaped.rowCount ?? null,
    };
  }
  return { rows: [], rowCount: null };
}

// -- Error handling -----------------------------------------------------------

interface PgErrorShape extends Error {
  code: string;
  detail?: string;
  constraint?: string;
}

function isPgError(e: unknown): e is PgErrorShape {
  return (
    e instanceof Error && "code" in e && typeof e.code === "string"
  );
}

function wrapError(e: unknown): Error {
  if (isPgError(e)) {
    return new SqlError(e.message, e.code, e.detail, e.constraint, e);
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}

// -- Public -------------------------------------------------------------------

/**
 * Wraps a Drizzle PG database into the SqlClient interface.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/postgres-js";
 * import { createDrizzleClient } from "bash-gres/drizzle";
 *
 * const db = drizzle(sql);
 * const client = createDrizzleClient(db);
 * ```
 */
export function createDrizzleClient(db: DrizzleDb): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        const query = buildQuery(text, params);
        const result: unknown = await db.execute(query);
        return normalizeResult<T>(result);
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      return db.transaction((tx) => fn(createDrizzleClient(tx)));
    },
  };
}

// -- setup (Drizzle-native) ---------------------------------------------------

/**
 * Drizzle-native setup — accepts a Drizzle `db` instance directly.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/postgres-js";
 * import { setup } from "bash-gres/drizzle";
 *
 * const db = drizzle(sql);
 * await setup(db);
 * ```
 */
export function setup(db: DrizzleDb, options?: SetupOptions): Promise<void> {
  return coreSetup(createDrizzleClient(db), options);
}

// -- PgFileSystem (Drizzle-native) --------------------------------------------

export type DrizzlePgFileSystemOptions = Omit<PgFileSystemOptions, "db"> & {
  db: DrizzleDb;
};

/**
 * PgFileSystem that accepts a Drizzle `db` instance directly.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/postgres-js";
 * import { PgFileSystem } from "bash-gres/drizzle";
 *
 * const db = drizzle(sql);
 * const fs = new PgFileSystem({ db, workspaceId: "ws-1" });
 * ```
 */
export class PgFileSystem extends CorePgFileSystem {
  constructor(options: DrizzlePgFileSystemOptions) {
    super({ ...options, db: createDrizzleClient(options.db) });
  }
}
