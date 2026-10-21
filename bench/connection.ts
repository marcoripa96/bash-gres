/**
 * Shared bench plumbing: open a SqlClient over the driver under test, and
 * optionally put bench/latency-proxy in front of the database.
 */
import { fork, type ChildProcess } from "node:child_process";
import postgresLib from "postgres";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import {
  createDrizzleClient,
  type DrizzleDb,
} from "../lib/adapters/drizzle/adapter.js";
import type { SqlClient } from "../lib/core/types.js";

export type BenchDriver = "postgres" | "bun-drizzle";

export interface BenchConnection {
  client: SqlClient;
  close: () => Promise<void>;
}

interface BunSqlModule {
  SQL: new (url: string, options: { max: number }) => { close(): Promise<void> };
}
interface BunDrizzleModule {
  drizzle: (client: unknown) => DrizzleDb;
}

/**
 * "postgres": postgres.js through createPostgresClient (PREPARE=1 opts into
 * prepared statements). "bun-drizzle": Bun SQL -> drizzle-orm/bun-sql ->
 * createDrizzleClient; run the compiled bench with `bun`.
 */
export async function connect(
  url: URL,
  driver: BenchDriver,
  pool: number,
): Promise<BenchConnection> {
  if (driver === "bun-drizzle") {
    // Variable specifiers keep tsc from resolving Bun-only modules.
    const bunSpecifier = "bun";
    const drizzleSpecifier = "drizzle-orm/bun-sql";
    const { SQL } = (await import(bunSpecifier)) as BunSqlModule;
    const { drizzle } = (await import(drizzleSpecifier)) as BunDrizzleModule;
    const sql = new SQL(url.href, { max: pool });
    return { client: createDrizzleClient(drizzle(sql)), close: () => sql.close() };
  }
  const sql = postgresLib(url.href, { onnotice: () => {}, max: pool });
  return {
    client: createPostgresClient(sql, { prepare: process.env["PREPARE"] === "1" }),
    close: () => sql.end(),
  };
}

/**
 * Start bench/latency-proxy in its own process in front of `target` and
 * return the URL that goes through it. A separate process keeps the delay
 * timers off the measured client's event loop.
 */
export async function startLatencyProxy(
  target: URL,
  oneWayMs: string,
  listenPort: number,
): Promise<{ url: URL; proc: ChildProcess }> {
  const proc = fork(new URL("./latency-proxy.js", import.meta.url), [
    String(listenPort),
    target.hostname,
    target.port || "5432",
    oneWayMs,
  ]);
  await new Promise<void>((resolve, reject) => {
    proc.once("message", () => resolve());
    proc.once("exit", (code) =>
      reject(new Error(`latency proxy exited (${code})`)),
    );
  });
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(listenPort);
  return { url, proc };
}
