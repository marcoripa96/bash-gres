/**
 * Cross-adapter performance benchmark.
 *
 * Runs the same workload through each available adapter (postgres.js,
 * node-postgres, Drizzle) and prints a side-by-side comparison so
 * regressions in any single adapter are obvious.
 *
 * Usage:
 *   docker compose up -d
 *   npm run bench:adapters
 *
 * Optional env:
 *   TEST_DATABASE_URL  override connection string (default: localhost:5433)
 *   BENCH_ADAPTERS     comma-separated subset, e.g. "postgres.js,drizzle"
 *   BENCH_OUTPUT       path to append markdown table (default: bench/adapter-results.md)
 */
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { hrtime } from "node:process";
import postgresLib from "postgres";
import pg from "pg";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { createNodePgClient } from "../lib/adapters/node-postgres/index.js";
import { createDrizzleClient } from "../lib/adapters/drizzle/adapter.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type { SqlClient } from "../lib/core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const OUTFILE = process.env["BENCH_OUTPUT"] ?? "bench/adapter-results.md";
const SELECTED = (process.env["BENCH_ADAPTERS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface AdapterHandle {
  name: string;
  client: SqlClient;
  teardown: () => Promise<void>;
}

async function makePostgresAdapter(): Promise<AdapterHandle> {
  const sql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
  return {
    name: "postgres.js",
    client: createPostgresClient(sql),
    teardown: () => sql.end(),
  };
}

async function makeNodePgAdapter(): Promise<AdapterHandle> {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  return {
    name: "node-postgres",
    client: createNodePgClient(pool),
    teardown: () => pool.end(),
  };
}

async function makeDrizzleAdapter(): Promise<AdapterHandle> {
  const sql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
  const db = drizzle(sql);
  return {
    name: "drizzle",
    client: createDrizzleClient(db),
    teardown: () => sql.end(),
  };
}

const ADAPTER_FACTORIES: Record<string, () => Promise<AdapterHandle>> = {
  "postgres.js": makePostgresAdapter,
  "node-postgres": makeNodePgAdapter,
  drizzle: makeDrizzleAdapter,
};

// -- Timing utilities ------------------------------------------------------

function ms(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function fmtMs(n: number): string {
  if (n < 1) return `${n.toFixed(3)} ms`;
  if (n < 100) return `${n.toFixed(2)} ms`;
  return `${n.toFixed(1)} ms`;
}

async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ns: bigint }> {
  const t0 = hrtime.bigint();
  const result = await fn();
  return { result, ns: hrtime.bigint() - t0 };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function p95(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

// -- Workload --------------------------------------------------------------

interface Sample {
  scenario: string;
  totalMs: number;
  medianMs?: number;
  p95Ms?: number;
}

async function resetWorkspace(client: SqlClient, ws: string) {
  await client.query("DELETE FROM fs_entries WHERE workspace_id = $1", [ws]);
  await client.query(
    "DELETE FROM version_ancestors WHERE workspace_id = $1",
    [ws],
  );
  await client.query("DELETE FROM fs_versions WHERE workspace_id = $1", [ws]);
  await client.query(
    "DELETE FROM fs_version_roots WHERE workspace_id = $1",
    [ws],
  );
  await client.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [ws]);
}

async function runWorkload(handle: AdapterHandle): Promise<Sample[]> {
  const ws = `bench-adapter-${handle.name.replace(/[^a-z0-9]/gi, "-")}`;
  await resetWorkspace(handle.client, ws);

  const fs = new PgFileSystem({
    db: handle.client,
    workspaceId: ws,
    maxFiles: 5000,
  });
  await fs.init();

  const samples: Sample[] = [];

  // -- Scenario: bulk writeFile (small text) -------------------------------
  {
    const N = 200;
    const t0 = hrtime.bigint();
    for (let i = 0; i < N; i++) {
      await fs.writeFile(`/bulk/${i}.txt`, `content-${i}`);
    }
    const total = ms(hrtime.bigint() - t0);
    samples.push({
      scenario: `writeFile x${N} (small text)`,
      totalMs: total,
    });
  }

  // -- Scenario: read latency (small text) --------------------------------
  {
    const ITER = 200;
    const latencies: number[] = [];
    // Warm up
    for (let i = 0; i < 20; i++) await fs.readFile(`/bulk/0.txt`);
    for (let i = 0; i < ITER; i++) {
      const { ns } = await time(() => fs.readFile(`/bulk/${i % 200}.txt`));
      latencies.push(ms(ns));
    }
    samples.push({
      scenario: `readFile x${ITER}`,
      totalMs: latencies.reduce((s, x) => s + x, 0),
      medianMs: median(latencies),
      p95Ms: p95(latencies),
    });
  }

  // -- Scenario: readdir (200 entries) ------------------------------------
  {
    const ITER = 50;
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) await fs.readdir("/bulk");
    for (let i = 0; i < ITER; i++) {
      const { ns } = await time(() => fs.readdir("/bulk"));
      latencies.push(ms(ns));
    }
    samples.push({
      scenario: `readdir(200 entries) x${ITER}`,
      totalMs: latencies.reduce((s, x) => s + x, 0),
      medianMs: median(latencies),
      p95Ms: p95(latencies),
    });
  }

  // -- Scenario: writeFile + binary 64KiB ---------------------------------
  {
    const N = 50;
    const blob = new Uint8Array(64 * 1024);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 31 + 7) & 0xff;
    const t0 = hrtime.bigint();
    for (let i = 0; i < N; i++) {
      // Each file gets a different first byte so blobs aren't deduped.
      blob[0] = i & 0xff;
      await fs.writeFile(`/bin/${i}.dat`, blob);
    }
    samples.push({
      scenario: `writeFile x${N} (64 KiB binary)`,
      totalMs: ms(hrtime.bigint() - t0),
    });
  }

  // -- Scenario: stat round-trip (transaction overhead proxy) -------------
  {
    const ITER = 200;
    const latencies: number[] = [];
    for (let i = 0; i < 10; i++) await fs.stat("/bulk/0.txt");
    for (let i = 0; i < ITER; i++) {
      const { ns } = await time(() => fs.stat(`/bulk/${i % 200}.txt`));
      latencies.push(ms(ns));
    }
    samples.push({
      scenario: `stat x${ITER}`,
      totalMs: latencies.reduce((s, x) => s + x, 0),
      medianMs: median(latencies),
      p95Ms: p95(latencies),
    });
  }

  // -- Scenario: recursive cp (200 files) ---------------------------------
  {
    const { ns } = await time(() =>
      fs.cp("/bulk", "/bulk-copy", { recursive: true }),
    );
    samples.push({
      scenario: `cp -r (200 files)`,
      totalMs: ms(ns),
    });
  }

  // -- Scenario: fork after 200 files -------------------------------------
  {
    const { ns } = await time(() => fs.fork("forked"));
    samples.push({
      scenario: `fork (200 files)`,
      totalMs: ms(ns),
    });
  }

  return samples;
}

// -- Output ----------------------------------------------------------------

function formatTable(
  scenarios: string[],
  results: Map<string, Sample[]>,
): string {
  const adapters = Array.from(results.keys());
  const lines: string[] = [];

  lines.push("");
  lines.push("### Total elapsed");
  lines.push("");
  lines.push("| Scenario | " + adapters.join(" | ") + " |");
  lines.push("| --- | " + adapters.map(() => "---").join(" | ") + " |");
  for (const scenario of scenarios) {
    const row: string[] = [scenario];
    for (const adapter of adapters) {
      const samples = results.get(adapter) ?? [];
      const s = samples.find((x) => x.scenario === scenario);
      row.push(s ? fmtMs(s.totalMs) : "—");
    }
    lines.push("| " + row.join(" | ") + " |");
  }

  // Median + p95 only for scenarios that recorded them
  const latencyScenarios = scenarios.filter((sc) => {
    for (const adapter of adapters) {
      const samples = results.get(adapter) ?? [];
      const s = samples.find((x) => x.scenario === sc);
      if (s?.medianMs !== undefined) return true;
    }
    return false;
  });
  if (latencyScenarios.length > 0) {
    lines.push("");
    lines.push("### Per-call latency (median / p95)");
    lines.push("");
    lines.push("| Scenario | " + adapters.join(" | ") + " |");
    lines.push("| --- | " + adapters.map(() => "---").join(" | ") + " |");
    for (const scenario of latencyScenarios) {
      const row: string[] = [scenario];
      for (const adapter of adapters) {
        const samples = results.get(adapter) ?? [];
        const s = samples.find((x) => x.scenario === scenario);
        if (s?.medianMs !== undefined && s.p95Ms !== undefined) {
          row.push(`${fmtMs(s.medianMs)} / ${fmtMs(s.p95Ms)}`);
        } else {
          row.push("—");
        }
      }
      lines.push("| " + row.join(" | ") + " |");
    }
  }

  return lines.join("\n");
}

function printConsoleTable(
  scenarios: string[],
  results: Map<string, Sample[]>,
) {
  const adapters = Array.from(results.keys());
  const colWidth = 18;
  const scenarioWidth = 40;

  const header =
    "Scenario".padEnd(scenarioWidth) +
    adapters.map((a) => a.padStart(colWidth)).join("");
  console.log("\n" + header);
  console.log("-".repeat(header.length));

  for (const scenario of scenarios) {
    let row = scenario.padEnd(scenarioWidth);
    for (const adapter of adapters) {
      const samples = results.get(adapter) ?? [];
      const s = samples.find((x) => x.scenario === scenario);
      const txt = s ? fmtMs(s.totalMs) : "—";
      row += txt.padStart(colWidth);
    }
    console.log(row);
  }

  // Latencies
  const latencyScenarios = scenarios.filter((sc) =>
    adapters.some((adapter) =>
      (results.get(adapter) ?? []).some(
        (x) => x.scenario === sc && x.medianMs !== undefined,
      ),
    ),
  );
  if (latencyScenarios.length === 0) return;

  console.log(
    "\nPer-call latency (median / p95):\n" + "-".repeat(header.length),
  );
  for (const scenario of latencyScenarios) {
    let row = scenario.padEnd(scenarioWidth);
    for (const adapter of adapters) {
      const samples = results.get(adapter) ?? [];
      const s = samples.find((x) => x.scenario === scenario);
      const txt =
        s?.medianMs !== undefined && s.p95Ms !== undefined
          ? `${fmtMs(s.medianMs)} / ${fmtMs(s.p95Ms)}`
          : "—";
      row += txt.padStart(colWidth);
    }
    console.log(row);
  }
}

// -- Main ------------------------------------------------------------------

async function main() {
  // Idempotent setup using a throwaway postgres.js client.
  const setupSql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
  await setup(createPostgresClient(setupSql), {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });
  await setupSql.end();

  const adapterNames = Object.keys(ADAPTER_FACTORIES).filter(
    (n) => SELECTED.length === 0 || SELECTED.includes(n),
  );

  if (adapterNames.length === 0) {
    throw new Error(
      `No adapters selected. Available: ${Object.keys(ADAPTER_FACTORIES).join(", ")}`,
    );
  }

  console.log(`Running adapter perf for: ${adapterNames.join(", ")}`);
  console.log(`DB: ${TEST_DB_URL}`);

  const results = new Map<string, Sample[]>();
  let scenarios: string[] = [];

  for (const name of adapterNames) {
    console.log(`\n--- ${name} ---`);
    const handle = await ADAPTER_FACTORIES[name]!();
    try {
      const samples = await runWorkload(handle);
      results.set(handle.name, samples);
      if (scenarios.length === 0) {
        scenarios = samples.map((s) => s.scenario);
      }
      for (const s of samples) {
        console.log(
          `  ${s.scenario.padEnd(40)} total=${fmtMs(s.totalMs).padStart(10)}` +
            (s.medianMs !== undefined && s.p95Ms !== undefined
              ? `  median=${fmtMs(s.medianMs).padStart(8)}  p95=${fmtMs(s.p95Ms).padStart(8)}`
              : ""),
        );
      }
    } finally {
      await handle.teardown();
    }
  }

  printConsoleTable(scenarios, results);

  // Markdown output
  const ts = new Date().toISOString();
  const block = `\n## adapter perf  _(${ts})_\n${formatTable(scenarios, results)}\n`;
  if (!existsSync(OUTFILE)) {
    writeFileSync(OUTFILE, "# bash-gres adapter benchmark results\n");
  }
  appendFileSync(OUTFILE, block);
  console.log(`\nAppended results to ${OUTFILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
