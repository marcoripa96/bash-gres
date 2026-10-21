/**
 * Agent-session benchmark: the shell commands an agent runs, through
 * just-bash over PgFileSystem, measured per command with the built-in
 * tracer (statements sent, fs ops issued, peak op concurrency, wall time).
 *
 *   docker compose up -d
 *   npm run bench:agent -- --seed            # once: load this repo's files
 *   npm run bench:agent -- --ro --rtt 0.5    # read-only, ~2.5 ms round-trips
 *
 * Flags:
 *   --seed        (re)load lib/, tests/, bench/, examples/ and top-level docs
 *                 into the bench workspace under /repo
 *   --ro          run on a `permissions: { write: false }` instance
 *   --rtt <ms>    one-way delay added by bench/latency-proxy (forked)
 *   --reps <n>    timed runs per command, median reported (default 5)
 *   --driver bun-drizzle   Bun SQL -> drizzle-orm/bun-sql -> createDrizzleClient
 *                 (run the compiled file with `bun`); default postgres.js
 *
 * Env: TEST_DATABASE_URL (default localhost:5434), POOL (connections,
 * default 10, the postgres.js and Bun default), PREPARE=1 (postgres.js
 * prepared statements), BENCH_OUTPUT (append the markdown table there).
 *
 * Median times on the proxy vary ~±15% run to run; compare branches with
 * alternating runs, and lean on the statement counts, which don't vary.
 */
import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import postgresLib from "postgres";
import { Bash } from "just-bash";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import {
  createDrizzleClient,
  type DrizzleDb,
} from "../lib/adapters/drizzle/adapter.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type {
  SqlClient,
  TraceEvent,
  TraceOpEvent,
  TraceQueryEvent,
} from "../lib/core/types.js";

const COMMANDS = [
  "ls",
  "ls -la",
  "ls lib/core",
  "ls -la lib/core",
  "ls -R lib | head -50",
  "cat lib/core/mounts.ts",
  "head -40 lib/core/filesystem.ts",
  "sed -n 100,140p lib/core/filesystem.ts",
  "wc -l lib/core/*.ts",
  "find . -name '*.ts' | wc -l",
  "find lib -type f",
  "grep -rn 'withReadOnlyWorkspace' lib",
  "grep -rl 'SqlClient' .",
  "grep -n 'async' lib/core/search.ts",
  "test -f package.json && echo yes",
  "[ -d lib/core ] && echo dir",
  "cat package.json | grep version",
  "du -sh lib",
  "tree lib/adapters 2>/dev/null || ls lib/adapters",
];

const WORKSPACE = "bench-agent-session";
const SEED_DIRS = ["lib", "tests", "bench", "examples"];
const SEED_FILES = ["README.md", "CLAUDE.md", "package.json", "FOLLOWUPS.md"];
const SEED_EXT = /\.(ts|md|json|sql|yml)$/;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const reps = Number(option("--reps") ?? 5);
const rttOneWayMs = option("--rtt");
const driver = option("--driver") ?? "postgres";
const pool = Number(process.env["POOL"] ?? 10);
const dbUrl = new URL(
  process.env["TEST_DATABASE_URL"] ??
    "postgres://postgres:postgres@localhost:5434/bashgres_test",
);

// just-bash blocks globalThis.performance while a script runs (under Bun):
// bind the clock once, before any command executes.
const now = performance.now.bind(performance);

async function startProxy(oneWayMs: string): Promise<{ url: URL; proc: ChildProcess }> {
  const listenPort = 15435;
  const proc = fork(new URL("./latency-proxy.js", import.meta.url), [
    String(listenPort),
    dbUrl.hostname,
    dbUrl.port || "5432",
    oneWayMs,
  ]);
  await new Promise<void>((resolve, reject) => {
    proc.once("message", () => resolve());
    proc.once("exit", (code) => reject(new Error(`latency proxy exited (${code})`)));
  });
  const url = new URL(dbUrl);
  url.hostname = "127.0.0.1";
  url.port = String(listenPort);
  return { url, proc };
}

interface Connection {
  client: SqlClient;
  close: () => Promise<void>;
}

interface BunSqlModule {
  SQL: new (url: string, options: { max: number }) => { close(): Promise<void> };
}
interface BunDrizzleModule {
  drizzle: (client: unknown) => DrizzleDb;
}

async function connect(url: URL): Promise<Connection> {
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

async function seed(client: SqlClient): Promise<number> {
  await setup(client, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });
  for (const table of [
    "fs_entries",
    "version_ancestors",
    "fs_versions",
    "fs_version_roots",
    "fs_blobs",
  ]) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [WORKSPACE]);
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SEED_EXT.test(name)) files.push(full);
    }
  };
  for (const d of SEED_DIRS) walk(d);
  files.push(...SEED_FILES);
  const fs = new PgFileSystem({ db: client, workspaceId: WORKSPACE, maxFiles: 20_000 });
  await fs.init();
  await fs.transaction(async (tx) => {
    for (const f of files) {
      const target = "/repo/" + relative(".", f);
      await tx.mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true });
      await tx.writeFile(target, readFileSync(f, "utf8"));
    }
  });
  await client.query("ANALYZE");
  return files.length;
}

interface Row {
  command: string;
  ops: number;
  queries: number;
  medianMs: number;
  peakConcurrency: number;
  breakdown: string;
}

function summarize(command: string, events: TimedEvent[], times: number[]): Row {
  const queries = events.filter((e): e is TimedEvent & TraceQueryEvent => e.type === "query");
  const ops = events.filter((e): e is TimedEvent & TraceOpEvent => e.type === "op");
  const spans = ops
    .filter((o) => o.parentId === null)
    .map((o) => [o.end - o.durationMs, o.end] as const);
  let peak = 0;
  for (const [start] of spans) {
    peak = Math.max(peak, spans.filter(([s, e]) => s <= start && e > start).length);
  }
  const byName = new Map<string, number>();
  for (const o of ops) byName.set(o.name, (byName.get(o.name) ?? 0) + 1);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    command,
    ops: ops.length,
    queries: queries.length,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    peakConcurrency: peak,
    breakdown: [...byName].map(([name, n]) => `${name}×${n}`).join(" "),
  };
}

type TimedEvent = TraceEvent & { end: number };

async function main() {
  const proxy = rttOneWayMs === undefined ? null : await startProxy(rttOneWayMs);
  const conn = await connect(proxy?.url ?? dbUrl);
  try {
    if (flag("--seed")) {
      console.log(`seeded ${await seed(conn.client)} files into ${WORKSPACE}:/repo`);
    }
    let events: TimedEvent[] | null = null;
    const fs = new PgFileSystem({
      db: conn.client,
      workspaceId: WORKSPACE,
      maxFiles: 20_000,
      ...(flag("--ro") ? { permissions: { read: true, write: false } } : {}),
      trace: (e) => events?.push({ ...e, end: now() }),
    });
    const bash = new Bash({ fs, cwd: "/repo" });

    const label = [
      driver,
      flag("--ro") ? "read-only" : "read-write",
      rttOneWayMs === undefined ? "loopback" : `+${rttOneWayMs} ms one-way`,
      `pool ${pool}`,
      process.env["PREPARE"] === "1" ? "prepared" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const rows: Row[] = [];
    for (const command of COMMANDS) {
      await bash.exec(command); // warm: version id, plans, connections
      const times: number[] = [];
      let last: TimedEvent[] = [];
      for (let r = 0; r < reps; r++) {
        events = [];
        const t0 = now();
        await bash.exec(command);
        times.push(now() - t0);
        last = events;
        events = null;
      }
      rows.push(summarize(command, last, times));
    }

    const lines = [
      `### agent session: ${label}`,
      "",
      "| Command | Statements | Ops | Peak concurrency | Median ms | Ops |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
      ...rows.map(
        (r) =>
          `| \`${r.command.replace(/\|/g, "\\|")}\` | ${r.queries} | ${r.ops} | ${r.peakConcurrency} | ${r.medianMs.toFixed(2)} | ${r.breakdown} |`,
      ),
      `| **total** | ${rows.reduce((n, r) => n + r.queries, 0)} | | | ${rows
        .reduce((n, r) => n + r.medianMs, 0)
        .toFixed(2)} | |`,
      "",
    ];
    console.log(lines.join("\n"));
    const out = process.env["BENCH_OUTPUT"];
    if (out) appendFileSync(out, lines.join("\n") + "\n");
  } finally {
    await conn.close();
    proxy?.proc.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
