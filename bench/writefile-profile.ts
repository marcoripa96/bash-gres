/**
 * Profile a single writeFile to expose where time goes per call:
 * round-trip count, per-query timing, breakdown of what's running.
 *
 *   node dist-bench/bench/writefile-profile.js
 */
import { hrtime } from "node:process";
import postgresLib from "postgres";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type { SqlClient, SqlParam, QueryResult } from "../lib/core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

interface Sample {
  text: string;
  ms: number;
}

function instrument(inner: SqlClient, samples: Sample[]): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      const t0 = hrtime.bigint();
      const r = await inner.query<T>(text, params);
      const ms = Number(hrtime.bigint() - t0) / 1_000_000;
      samples.push({ text: text.replace(/\s+/g, " ").trim().slice(0, 80), ms });
      return r;
    },
    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      const t0 = hrtime.bigint();
      samples.push({ text: "<<transaction begin>>", ms: 0 });
      const r = await inner.transaction((tx) => fn(instrument(tx, samples)));
      const ms = Number(hrtime.bigint() - t0) / 1_000_000;
      samples.push({ text: "<<transaction total>>", ms });
      return r;
    },
  };
}

async function main() {
  const sql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
  const base = createPostgresClient(sql);

  await setup(base, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });

  const ws = "bench-writefile-profile";
  await base.query("DELETE FROM fs_entries WHERE workspace_id = $1", [ws]);
  await base.query("DELETE FROM version_ancestors WHERE workspace_id = $1", [ws]);
  await base.query("DELETE FROM fs_versions WHERE workspace_id = $1", [ws]);
  await base.query("DELETE FROM fs_version_roots WHERE workspace_id = $1", [ws]);
  await base.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [ws]);

  const samples: Sample[] = [];
  const fs = new PgFileSystem({
    db: instrument(base, samples),
    workspaceId: ws,
  });

  console.log("=== fs.init() ===");
  samples.length = 0;
  const initT = hrtime.bigint();
  await fs.init();
  const initMs = Number(hrtime.bigint() - initT) / 1_000_000;
  printSamples(samples);
  console.log(`init total: ${initMs.toFixed(2)} ms`);

  console.log("\n=== first writeFile (cold caches) ===");
  samples.length = 0;
  const w1T = hrtime.bigint();
  await fs.writeFile("/first.txt", "hello");
  const w1Ms = Number(hrtime.bigint() - w1T) / 1_000_000;
  printSamples(samples);
  console.log(`writeFile #1 total: ${w1Ms.toFixed(2)} ms`);

  console.log("\n=== second writeFile (caches warm) ===");
  samples.length = 0;
  const w2T = hrtime.bigint();
  await fs.writeFile("/second.txt", "world");
  const w2Ms = Number(hrtime.bigint() - w2T) / 1_000_000;
  printSamples(samples);
  console.log(`writeFile #2 total: ${w2Ms.toFixed(2)} ms`);

  console.log("\n=== writeFile #3..#10 (warm, averaged) ===");
  const warmTimings: number[] = [];
  const warmCounts: number[] = [];
  for (let i = 3; i < 11; i++) {
    samples.length = 0;
    const t0 = hrtime.bigint();
    await fs.writeFile(`/n${i}.txt`, `body-${i}`);
    warmTimings.push(Number(hrtime.bigint() - t0) / 1_000_000);
    warmCounts.push(samples.filter((s) => !s.text.startsWith("<<")).length);
  }
  console.log(
    `mean=${avg(warmTimings).toFixed(2)} ms, median=${median(warmTimings).toFixed(2)} ms, queries/write=${warmCounts[0]}`,
  );

  await sql.end();
}

function printSamples(samples: Sample[]) {
  for (const s of samples) {
    console.log(`  ${s.ms.toFixed(2).padStart(7)} ms  ${s.text}`);
  }
  const real = samples.filter((s) => !s.text.startsWith("<<"));
  console.log(`  ${real.length} queries, sum=${sum(real.map((s) => s.ms)).toFixed(2)} ms`);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function avg(xs: number[]): number {
  return sum(xs) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
