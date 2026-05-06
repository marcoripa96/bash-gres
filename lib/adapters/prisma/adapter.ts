import type {
  SqlClient,
  QueryResult,
  SqlParam,
  PgFileSystemOptions,
  SetupOptions,
} from "../../core/types.js";
import { SqlError } from "../../core/types.js";
import { PgFileSystem as CorePgFileSystem } from "../../core/filesystem.js";
import { setup as coreSetup } from "../../core/setup.js";

/**
 * Structural interface for a Prisma client (or interactive transaction client).
 * Matches the public methods used here without importing `@prisma/client`.
 */
export interface PrismaLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<number>;
  $transaction<R>(
    fn: (tx: PrismaLike) => Promise<R>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: unknown;
    },
  ): Promise<R>;
}

export interface PrismaClientOptions {
  /**
   * Forwarded to `prisma.$transaction()` for the top-level transaction.
   * Prisma's interactive-transaction defaults are short (5s timeout / 2s
   * maxWait); raise them so longer fs ops like recursive copies don't
   * abort mid-flight.
   */
  transactionOptions?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: unknown;
  };
}

const DEFAULT_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 30_000,
} as const;

// -- Param serialization -----------------------------------------------------

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

/**
 * Prisma's raw-query engine accepts strings, numbers, booleans, BigInt, Date,
 * Buffer, and `Prisma.Sql`/`Prisma.Decimal` values, but its handling of plain
 * JS arrays is unreliable across versions and column types. We pre-serialize
 * arrays to a Postgres array literal string so the in-query `::bigint[]` /
 * `::text[]` / `::lquery[]` casts coerce them back, exactly like the Drizzle
 * adapter. Uint8Arrays become Buffers so they round-trip as `bytea`.
 */
function serializeParam(value: SqlParam): unknown {
  if (Array.isArray(value)) return pgArrayLiteral(value);
  if (value instanceof Uint8Array && !(value instanceof Buffer)) {
    return Buffer.from(value);
  }
  return value;
}

// -- Multi-statement splitting ----------------------------------------------

/**
 * Prisma's `$executeRawUnsafe` / `$queryRawUnsafe` use the extended Postgres
 * protocol, which rejects compound commands ("cannot insert multiple commands
 * into a prepared statement"). The core's `setup()` happens to ship its DDL
 * as semicolon-joined batches. Split parameterless inputs into individual
 * statements so each one goes through as its own prepared command.
 *
 * Aware of: `'string'` (with `''` escape), `"identifier"`, `--` line and
 * `/* *\/` block comments, and `$tag$ ... $tag$` dollar quoting (with or
 * without a tag) — all of which can legally embed unescaped `;`.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i]!;

    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        buf += sql[i];
        i++;
      }
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, sql.length);
      buf += sql.slice(start, i);
      continue;
    }

    if (c === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      buf += sql.slice(start, i);
      continue;
    }

    if (c === '"') {
      const start = i;
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i = Math.min(i + 1, sql.length);
      buf += sql.slice(start, i);
      continue;
    }

    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const start = i;
        i += tag.length;
        const close = sql.indexOf(tag, i);
        if (close === -1) {
          buf += sql.slice(start, i);
          continue;
        }
        i = close + tag.length;
        buf += sql.slice(start, i);
        continue;
      }
    }

    if (c === ";") {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  const trimmed = buf.trim();
  if (trimmed) out.push(trimmed);
  return out;
}

// -- Result normalization ----------------------------------------------------

/**
 * Prisma deserializes Postgres `bigint` columns as JS `BigInt`, while pg /
 * postgres.js return them as `string`. The core code already uses
 * `Number(row.id)` to coerce, but BigInts also break `JSON.stringify` and
 * direct numeric comparisons (`5n !== 5`). Coerce BigInts to Numbers up
 * front so call sites behave the same regardless of adapter.
 */
function coerceRow<T>(row: unknown): T {
  if (row === null || typeof row !== "object") return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out as T;
}

function normalizeRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  return result.map((r) => coerceRow<T>(r));
}

// -- Query routing -----------------------------------------------------------

/**
 * Decide whether a raw SQL statement should go through `$queryRawUnsafe`
 * (returns rows) or `$executeRawUnsafe` (returns a row count). Prisma's
 * query engine treats them as different operations and won't return rows
 * from `$executeRawUnsafe`, so we have to dispatch correctly.
 */
const RETURNING_RE = /\bRETURNING\b/i;
const READ_PREFIX_RE =
  /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\(?\s*(?:SELECT|WITH|VALUES|SHOW|TABLE|EXPLAIN)\b/i;

/**
 * Some Postgres functions (notably `pg_advisory_*_lock`) return the `void`
 * pseudo-type. Other drivers expose this as a one-row result with a NULL
 * column, but Prisma's query engine refuses to deserialize void and throws
 * `Failed to deserialize column of type 'void'`. The core uses these calls
 * for transaction-scoped locks and discards their results, so route them
 * through `$executeRawUnsafe` (which doesn't read column values).
 */
const VOID_RESULT_RE = /^\s*SELECT\s+pg_advisory_(?:xact_)?lock(?:_shared)?\s*\(/i;

function isReadQuery(text: string): boolean {
  if (VOID_RESULT_RE.test(text)) return false;
  if (READ_PREFIX_RE.test(text)) return true;
  if (RETURNING_RE.test(text)) return true;
  return false;
}

// -- Error handling ----------------------------------------------------------

interface PrismaErrorShape extends Error {
  code: string;
  meta?: Record<string, unknown>;
}

function isPrismaKnownError(e: unknown): e is PrismaErrorShape {
  return (
    e instanceof Error &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string" &&
    (e as { code: string }).code.startsWith("P")
  );
}

interface PgErrorShape extends Error {
  code: string;
  detail?: string;
  constraint?: string;
}

/**
 * Postgres SQLSTATE codes are five characters drawn from `[0-9A-Z]`. We
 * insist on that exact shape so user-thrown errors with `code` fields
 * (notably `FsError` / `FsQuotaError`, which carry codes like `ENOSPC`,
 * `EEXIST`, etc.) aren't misclassified as driver errors and re-wrapped
 * into `SqlError`.
 */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

function isPgError(e: unknown): e is PgErrorShape {
  if (!(e instanceof Error) || !("code" in e)) return false;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" && SQLSTATE_RE.test(code);
}

/**
 * Pull the original Postgres SQLSTATE out of a Prisma error. Prisma wraps
 * raw-query failures in `PrismaClientKnownRequestError` with `code: 'P2010'`
 * and stashes the underlying driver error in `meta.code` / `meta.message`.
 * Falling back to a raw pg-style error covers the case where the user
 * passes us a non-Prisma client.
 */
function findPgError(
  e: unknown,
): { code: string; message: string; detail?: string; constraint?: string } | undefined {
  if (isPrismaKnownError(e) && e.meta) {
    const code = e.meta["code"];
    const message = e.meta["message"];
    if (typeof code === "string") {
      return {
        code,
        message: typeof message === "string" ? message : e.message,
      };
    }
  }
  if (isPgError(e)) {
    return {
      code: e.code,
      message: e.message,
      detail: e.detail,
      constraint: e.constraint,
    };
  }
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (cause && cause !== e) return findPgError(cause);
  return undefined;
}

function wrapError(e: unknown): Error {
  const pg = findPgError(e);
  if (pg) {
    return new SqlError(
      pg.message,
      pg.code,
      pg.detail,
      pg.constraint,
      e instanceof Error ? e : undefined,
    );
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}

// -- Single-statement execution ---------------------------------------------

async function execStatement<T>(
  client: PrismaLike,
  text: string,
  args: unknown[],
): Promise<QueryResult<T>> {
  if (isReadQuery(text)) {
    const result = await client.$queryRawUnsafe<unknown>(text, ...args);
    const rows = normalizeRows<T>(result);
    return { rows, rowCount: rows.length };
  }
  const count = await client.$executeRawUnsafe(text, ...args);
  return { rows: [], rowCount: count };
}

async function execQuery<T>(
  client: PrismaLike,
  text: string,
  params: SqlParam[],
): Promise<QueryResult<T>> {
  if (params.length === 0) {
    const statements = splitSqlStatements(text);
    if (statements.length > 1) {
      let lastRows: T[] = [];
      let totalCount = 0;
      for (const stmt of statements) {
        const result = await execStatement<T>(client, stmt, []);
        if (result.rows.length > 0) lastRows = result.rows;
        if (result.rowCount !== null) totalCount += result.rowCount;
      }
      return { rows: lastRows, rowCount: totalCount };
    }
    if (statements.length === 1) {
      return execStatement<T>(client, statements[0]!, []);
    }
    return { rows: [], rowCount: 0 };
  }
  const args = params.map(serializeParam);
  return execStatement<T>(client, text, args);
}

// -- Transaction wrapping ----------------------------------------------------

let nextSavepointId = 0;

/**
 * Wrap a Prisma interactive-transaction client into a `SqlClient`. Nested
 * `transaction()` calls fall back to SAVEPOINTs because Prisma forbids
 * calling `$transaction` on a transaction client.
 */
function wrapTransactionClient(tx: PrismaLike): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        return await execQuery<T>(tx, text, params);
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      const sp = `bashgres_sp_${++nextSavepointId}`;
      await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
      try {
        const result = await fn(wrapTransactionClient(tx));
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (e: unknown) {
        try {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
        } catch {
          // ignore rollback errors
        }
        throw wrapError(e);
      }
    },
  };
}

// -- Public API --------------------------------------------------------------

/**
 * Wraps a Prisma client into the `SqlClient` interface.
 *
 * @example
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { createPrismaClient } from "bash-gres/prisma";
 *
 * const prisma = new PrismaClient();
 * const client = createPrismaClient(prisma);
 * ```
 */
export function createPrismaClient(
  prisma: PrismaLike,
  options: PrismaClientOptions = {},
): SqlClient {
  const txOptions = { ...DEFAULT_TRANSACTION_OPTIONS, ...options.transactionOptions };

  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      try {
        return await execQuery<T>(prisma, text, params);
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },

    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      try {
        return await prisma.$transaction(
          (tx: PrismaLike) => fn(wrapTransactionClient(tx)),
          txOptions,
        );
      } catch (e: unknown) {
        throw wrapError(e);
      }
    },
  };
}

// -- setup (Prisma-native) ---------------------------------------------------

/**
 * Prisma-native setup: accepts a Prisma client directly.
 *
 * @example
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { setup } from "bash-gres/prisma";
 *
 * const prisma = new PrismaClient();
 * await setup(prisma);
 * ```
 */
export function setup(prisma: PrismaLike, options?: SetupOptions): Promise<void> {
  return coreSetup(createPrismaClient(prisma), options);
}

// -- PgFileSystem (Prisma-native) --------------------------------------------

export type PrismaPgFileSystemOptions = Omit<PgFileSystemOptions, "db"> & {
  db: PrismaLike;
  prismaOptions?: PrismaClientOptions;
};

/**
 * `PgFileSystem` that accepts a Prisma client directly.
 *
 * @example
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { PgFileSystem } from "bash-gres/prisma";
 *
 * const prisma = new PrismaClient();
 * const fs = new PgFileSystem({ db: prisma, workspaceId: "ws-1" });
 * ```
 */
export class PgFileSystem extends CorePgFileSystem {
  constructor(options: PrismaPgFileSystemOptions) {
    const { prismaOptions, ...rest } = options;
    super({ ...rest, db: createPrismaClient(options.db, prismaOptions) });
  }
}
