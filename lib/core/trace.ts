import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type {
  QueryResult,
  SqlClient,
  SqlParam,
  TraceEvent,
  TraceOpRef,
} from "./types.js";

/**
 * Opt-in tracing for `PgFileSystemOptions.trace`. Nothing here runs unless a
 * sink is configured: the constructor only wraps the client and the public
 * methods when one is.
 *
 * Op attribution rides an `AsyncLocalStorage` frame rather than a per-call
 * view object, so concurrent calls on one instance stay apart without
 * splitting the instance's caches (a view would re-resolve the version id and
 * change the very query counts being measured).
 */

type TraceSink = (event: TraceEvent) => void;

interface OpFrame extends TraceOpRef {
  parent: OpFrame | null;
  queries: number;
  sqlMs: number;
}

const currentOp = new AsyncLocalStorage<OpFrame>();
let nextOpId = 1;

/** Public methods reported as `op` events. Sync helpers are left out. */
const TRACED_METHODS = [
  "init",
  "transaction",
  "readFile",
  "readFileBuffer",
  "readFileRange",
  "readFileLines",
  "readFileChunks",
  "writeFile",
  "appendFile",
  "exists",
  "stat",
  "lstat",
  "realpath",
  "mkdir",
  "readdir",
  "readdirWithFileTypes",
  "readdirWithStats",
  "walk",
  "glob",
  "rm",
  "cp",
  "mv",
  "chmod",
  "utimes",
  "symlink",
  "link",
  "readlink",
  "textSearch",
  "semanticSearch",
  "hybridSearch",
  "backfillChunks",
  "indexChunkEmbeddings",
  "getLastModified",
  "getUsage",
  "versioned",
  "diff",
  "diffCount",
  "diffVersions",
  "fork",
  "detach",
  "listHistory",
  "listVersions",
  "deleteVersion",
  "renameVersion",
  "promoteTo",
  "merge",
  "cherryPick",
  "revert",
  "sweepHistory",
  "versionDiff",
] as const;

function emit(sink: TraceSink, event: TraceEvent): void {
  try {
    sink(event);
  } catch {
    // A broken sink must not break the filesystem call it observes.
  }
}

export function traceSqlClient(
  inner: SqlClient,
  sink: TraceSink,
  inTransaction = false,
): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      const frame = currentOp.getStore() ?? null;
      const op = frame ? { id: frame.id, name: frame.name } : null;
      const t0 = performance.now();
      try {
        const r = await inner.query<T>(text, params);
        const durationMs = performance.now() - t0;
        if (frame) {
          frame.queries++;
          frame.sqlMs += durationMs;
        }
        emit(sink, {
          type: "query",
          sql: text,
          paramCount: params.length,
          durationMs,
          rows: r.rows.length,
          transaction: inTransaction,
          op,
        });
        return r;
      } catch (error) {
        const durationMs = performance.now() - t0;
        if (frame) {
          frame.queries++;
          frame.sqlMs += durationMs;
        }
        emit(sink, {
          type: "query",
          sql: text,
          paramCount: params.length,
          durationMs,
          rows: 0,
          transaction: inTransaction,
          op,
          error,
        });
        throw error;
      }
    },
    transaction<U>(fn: (tx: SqlClient) => Promise<U>): Promise<U> {
      return inner.transaction((tx) => fn(traceSqlClient(tx, sink, true)));
    },
  };
}

/**
 * Shadow each traced public method with an own-property wrapper that opens an
 * op frame for the duration of the call. Methods returning a non-promise
 * (async iterators such as `diffStream`) pass through untraced.
 */
export function traceMethods(target: object, sink: TraceSink): void {
  const record = target as Record<string, unknown>;
  for (const name of TRACED_METHODS) {
    const method = record[name];
    if (typeof method !== "function") continue;
    const original = method as (...args: unknown[]) => unknown;
    record[name] = function traced(this: unknown, ...args: unknown[]) {
      const parent = currentOp.getStore() ?? null;
      const frame: OpFrame = {
        id: nextOpId++,
        name,
        parent,
        queries: 0,
        sqlMs: 0,
      };
      const t0 = performance.now();
      const finish = (error?: unknown) =>
        emit(sink, {
          type: "op",
          id: frame.id,
          name,
          args: args.filter((a): a is string => typeof a === "string"),
          durationMs: performance.now() - t0,
          queries: frame.queries,
          sqlMs: frame.sqlMs,
          parentId: parent?.id ?? null,
          ...(error === undefined ? {} : { error }),
        });
      const result = currentOp.run(frame, () => original.apply(this, args));
      if (!(result instanceof Promise)) return result;
      return result.then(
        (value) => {
          finish();
          return value;
        },
        (error: unknown) => {
          finish(error);
          throw error;
        },
      );
    };
  }
}
