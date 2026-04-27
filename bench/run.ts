/**
 * Performance benchmark runner.
 *
 * Run with:
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/bashgres_test \
 *     npx tsx bench/run.ts
 *
 * Reports median + p95 latency for each scenario in milliseconds, plus the
 * number of queries each operation issues inside `withWorkspace` (captured
 * via a recording SqlClient). Numbers feed into PERFORMANCE.md.
 */

import postgres from "postgres";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient, QueryResult, SqlParam } from "../lib/core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5434/bashgres_test";

const ITERATIONS = parseInt(process.env["BENCH_ITERATIONS"] ?? "200", 10);

interface Sample {
  ms: number;
  queries: number;
}

interface Stats {
  count: number;
  median: number;
  p95: number;
  p99: number;
  queriesMedian: number;
}

function summarise(samples: Sample[]): Stats {
  const sorted = samples.slice().sort((a, b) => a.ms - b.ms);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]?.ms ?? 0;
  const queries = samples.map((s) => s.queries).sort((a, b) => a - b);
  const queriesMedian = queries[Math.floor(queries.length / 2)] ?? 0;
  return {
    count: samples.length,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    queriesMedian,
  };
}

interface RecordingHandle {
  client: SqlClient;
  queries: { count: number };
  reset: () => void;
}

function recording(inner: SqlClient): RecordingHandle {
  const queries = { count: 0 };
  function wrap(c: SqlClient): SqlClient {
    return {
      query<T = Record<string, unknown>>(
        text: string,
        params?: SqlParam[],
      ): Promise<QueryResult<T>> {
        queries.count++;
        return c.query<T>(text, params);
      },
      transaction<U>(fn: (tx: SqlClient) => Promise<U>): Promise<U> {
        return c.transaction((tx) => fn(wrap(tx)));
      },
    };
  }
  return {
    client: wrap(inner),
    queries,
    reset: () => {
      queries.count = 0;
    },
  };
}

async function resetWorkspace(
  client: SqlClient,
  workspaceId: string,
): Promise<void> {
  await client.query("DELETE FROM fs_entries WHERE workspace_id = $1", [
    workspaceId,
  ]);
  await client.query(
    "DELETE FROM version_ancestors WHERE workspace_id = $1",
    [workspaceId],
  );
  await client.query("DELETE FROM fs_versions WHERE workspace_id = $1", [
    workspaceId,
  ]);
  await client.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [
    workspaceId,
  ]);
}

async function timeOnce<T>(
  rec: RecordingHandle,
  label: string,
  fn: () => Promise<T>,
): Promise<Sample> {
  rec.reset();
  const start = process.hrtime.bigint();
  await fn();
  const end = process.hrtime.bigint();
  return {
    ms: Number(end - start) / 1e6,
    queries: rec.queries.count,
  };
}

interface Scenario {
  name: string;
  prepare: (fs: PgFileSystem) => Promise<void>;
  run: (fs: PgFileSystem, i: number) => Promise<void>;
  iterations?: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: "stat (existing file)",
    prepare: async (fs) => {
      await fs.writeFile("/target.txt", "x".repeat(1024));
    },
    run: async (fs) => {
      await fs.stat("/target.txt");
    },
  },
  {
    name: "writeFile 1KB (no embed)",
    prepare: async () => {},
    run: async (fs, i) => {
      await fs.writeFile(`/files/file-${i}.txt`, "x".repeat(1024));
    },
  },
  {
    name: "readFile 1KB",
    prepare: async (fs) => {
      await fs.writeFile("/r.txt", "x".repeat(1024));
    },
    run: async (fs) => {
      await fs.readFile("/r.txt");
    },
  },
  {
    name: "mv 1MB file",
    prepare: async () => {},
    run: async (fs, i) => {
      const src = `/big/src-${i}.bin`;
      const dst = `/big/dst-${i}.bin`;
      await fs.writeFile(src, new Uint8Array(1024 * 1024));
      await fs.mv(src, dst);
    },
    iterations: Math.min(ITERATIONS, 50),
  },
  {
    name: "mkdir -p depth 8",
    prepare: async () => {},
    run: async (fs, i) => {
      await fs.mkdir(`/m${i}/a/b/c/d/e/f/g`, { recursive: true });
    },
  },
  {
    name: "cp -r 50-node tree",
    prepare: async (fs) => {
      for (let i = 0; i < 50; i++) {
        await fs.writeFile(`/tree/f-${i}.txt`, `c${i}`);
      }
    },
    run: async (fs, i) => {
      await fs.cp("/tree", `/copy-${i}`, { recursive: true });
      await fs.rm(`/copy-${i}`, { recursive: true });
    },
    iterations: Math.min(ITERATIONS, 20),
  },
  {
    name: "readdir 100-entry dir",
    prepare: async (fs) => {
      for (let i = 0; i < 100; i++) {
        await fs.writeFile(`/d/f-${i}.txt`, "x");
      }
    },
    run: async (fs) => {
      await fs.readdir("/d");
    },
  },
  {
    name: "walk 200-node tree",
    prepare: async (fs) => {
      for (let i = 0; i < 20; i++) {
        for (let j = 0; j < 10; j++) {
          await fs.writeFile(`/w/sub-${i}/f-${j}.txt`, "x");
        }
      }
    },
    run: async (fs) => {
      await fs.walk("/w");
    },
    iterations: Math.min(ITERATIONS, 100),
  },
];

interface Result {
  scenario: string;
  stats: Stats;
}

function formatResults(results: Result[]): string {
  const header = ["scenario", "n", "median ms", "p95 ms", "p99 ms", "queries"];
  const rows = results.map((r) => [
    r.scenario,
    String(r.stats.count),
    r.stats.median.toFixed(2),
    r.stats.p95.toFixed(2),
    r.stats.p99.toFixed(2),
    String(r.stats.queriesMedian),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [
    fmtRow(header),
    fmtRow(widths.map((w) => "-".repeat(w))),
    ...rows.map(fmtRow),
  ].join("\n");
}

async function main() {
  const sql = postgres(TEST_DB_URL, { onnotice: () => {} });
  const inner = createPostgresClient(sql);

  await setup(inner, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });

  const results: Result[] = [];
  for (const scenario of SCENARIOS) {
    const iterations = scenario.iterations ?? ITERATIONS;
    const workspaceId = `bench-${scenario.name.replace(/\W+/g, "-")}-${Date.now()}`;
    await resetWorkspace(inner, workspaceId);

    const rec = recording(inner);
    const fs = new PgFileSystem({ db: rec.client, workspaceId });
    await fs.init();
    await scenario.prepare(fs);

    // Warmup
    for (let i = 0; i < Math.min(5, iterations); i++) {
      try {
        await scenario.run(fs, -1 - i);
      } catch {
        // ignore warmup errors caused by reused paths
      }
    }

    const samples: Sample[] = [];
    for (let i = 0; i < iterations; i++) {
      try {
        samples.push(await timeOnce(rec, scenario.name, () => scenario.run(fs, i)));
      } catch (e) {
        // Log but keep going so one bad iteration doesn't kill the run.
        // eslint-disable-next-line no-console
        console.error(`  [warn] ${scenario.name} iter ${i}:`, (e as Error).message);
      }
    }

    results.push({ scenario: scenario.name, stats: summarise(samples) });
    process.stdout.write(`  ${scenario.name}: median ${results[results.length - 1].stats.median.toFixed(2)}ms (n=${samples.length})\n`);
  }

  await sql.end();

  process.stdout.write("\n=== Results ===\n");
  process.stdout.write(formatResults(results));
  process.stdout.write("\n");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
