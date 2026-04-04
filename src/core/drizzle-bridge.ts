import type { SqlClient, QueryResult, SqlParam, DrizzleDb } from "./types.js";
import { SqlError } from "./types.js";

// Cached reference — resolved on first query, avoids loading drizzle-orm for postgres.js users
let cachedSqlBuilder:
  | ((text: string, params: SqlParam[]) => { getSQL(): unknown })
  | undefined;

async function getSqlBuilder(): Promise<
  (text: string, params: SqlParam[]) => { getSQL(): unknown }
> {
  if (cachedSqlBuilder) return cachedSqlBuilder;

  const { sql } = await import("drizzle-orm");

  cachedSqlBuilder = (text: string, params: SqlParam[]) => {
    if (params.length === 0) return sql.raw(text);

    const parts = text.split(/(\$\d+)/);
    const chunks: ReturnType<typeof sql.raw>[] = [];

    for (const part of parts) {
      const match = part.match(/^\$(\d+)$/);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        if (idx >= 0 && idx < params.length) {
          chunks.push(sql`${params[idx]}`);
        } else {
          chunks.push(sql.raw(part));
        }
      } else if (part) {
        chunks.push(sql.raw(part));
      }
    }

    return sql.join(chunks, sql.raw(""));
  };

  return cachedSqlBuilder;
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
 * Lazily loads `drizzle-orm` on first query so postgres.js-only
 * users never pay the import cost.
 */
export function toDrizzleSqlClient(db: DrizzleDb): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      const build = await getSqlBuilder();
      try {
        const query = build(text, params);
        const result: unknown = await db.execute(query);
        return normalizeResult<T>(result);
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      return db.transaction((tx) => fn(toDrizzleSqlClient(tx)));
    },
  };
}
