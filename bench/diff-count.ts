/**
 * Focused benchmark for diffCount() — used to measure before/after impact of
 * SQL or wiring changes in lib/core/filesystem/ops/diff-count.ts.
 *
 * Run:
 *   docker compose up -d
 *   BENCH_LABEL=before TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/bashgres_test \
 *     npx tsc -p tsconfig.bench.json && node dist-bench/bench/diff-count.js
 *
 * Then make changes, rerun with BENCH_LABEL=after, and compare bench/diff-count-results.md.
 */
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { hrtime } from "node:process";
import postgresLib from "postgres";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5434/bashgres_test";

const LABEL = process.env["BENCH_LABEL"] ?? "unlabeled";
const OUTFILE = process.env["BENCH_OUTPUT"] ?? "bench/diff-count-results.md";
const ITERATIONS = Number(process.env["BENCH_ITERATIONS"] ?? "50");
const WARMUP = Number(process.env["BENCH_WARMUP"] ?? "5");

const sql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
const client = createPostgresClient(sql);

interface Result {
  scenario: string;
  metric: string;
  value: string;
}
const results: Result[] = [];

function record(scenario: string, metric: string, value: string) {
  results.push({ scenario, metric, value });
  console.log(`  ${scenario.padEnd(48)} ${metric.padEnd(14)} ${value}`);
}

async function resetWs(workspaceId: string) {
  await client.query("DELETE FROM fs_entries WHERE workspace_id = $1", [workspaceId]);
  await client.query("DELETE FROM version_ancestors WHERE workspace_id = $1", [workspaceId]);
  await client.query("DELETE FROM fs_versions WHERE workspace_id = $1", [workspaceId]);
  await client.query("DELETE FROM fs_version_roots WHERE workspace_id = $1", [workspaceId]);
  await client.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [workspaceId]);
}

function ms(ns: bigint): number {
  return Number(ns) / 1_000_000;
}
function fmtMs(ns: bigint): string {
  return `${ms(ns).toFixed(3)} ms`;
}
async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ns: bigint }> {
  const t0 = hrtime.bigint();
  const result = await fn();
  return { result, ns: hrtime.bigint() - t0 };
}
function median(xs: bigint[]): bigint {
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)]!;
}
function p95(xs: bigint[]): bigint {
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

async function measure(
  label: string,
  expectedCount: number,
  fn: () => Promise<number>,
) {
  for (let i = 0; i < WARMUP; i++) {
    const got = await fn();
    if (got !== expectedCount) {
      throw new Error(`${label}: expected count ${expectedCount}, got ${got}`);
    }
  }
  const samples: bigint[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const { ns } = await time(fn);
    samples.push(ns);
  }
  record(label, "median", fmtMs(median(samples)));
  record(label, "p95", fmtMs(p95(samples)));
}

// -- Scenarios -------------------------------------------------------------

async function buildBaseWithEdits(
  ws: string,
  numFiles: number,
  numEdits: number,
  numAdds: number,
  numRms: number,
): Promise<{ a: PgFileSystem; b: PgFileSystem; expected: number }> {
  await resetWs(ws);
  const a = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "a",
    maxFiles: numFiles + numAdds + 100,
  });
  await a.init();
  for (let i = 0; i < numFiles; i++) {
    await a.writeFile(`/file-${i}.txt`, `c-${i}`);
  }
  const b = await a.fork("b");
  for (let i = 0; i < numEdits; i++) {
    await b.writeFile(`/file-${i}.txt`, `edited-${i}`);
  }
  for (let i = 0; i < numAdds; i++) {
    await b.writeFile(`/added-${i}.txt`, `new-${i}`);
  }
  for (let i = 0; i < numRms; i++) {
    await b.rm(`/file-${numFiles - 1 - i}.txt`);
  }
  const expected = numEdits + numAdds + numRms;
  return { a, b, expected };
}

async function benchSmallDiff() {
  const { a, expected } = await buildBaseWithEdits("bench-dc-small", 100, 10, 5, 5);
  await measure("100 files | 20 changes", expected, () => a.diffCount("b"));
}

async function benchMediumDiff() {
  const { a, expected } = await buildBaseWithEdits("bench-dc-medium", 1000, 80, 10, 10);
  await measure("1000 files | 100 changes", expected, () => a.diffCount("b"));
}

async function benchLargeSparseDiff() {
  const { a, expected } = await buildBaseWithEdits("bench-dc-large", 5000, 30, 10, 10);
  await measure("5000 files | 50 changes (sparse)", expected, () => a.diffCount("b"));
}

async function benchTombstoneHeavy() {
  const ws = "bench-dc-tombs";
  await resetWs(ws);
  const a = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "a",
    maxFiles: 3000,
  });
  await a.init();
  for (let i = 0; i < 1000; i++) await a.writeFile(`/f-${i}.txt`, `c-${i}`);
  const b = await a.fork("b");
  // Delete the back half: 500 tombstones in b's branch.
  for (let i = 500; i < 1000; i++) await b.rm(`/f-${i}.txt`);
  // And do 20 unrelated edits.
  for (let i = 0; i < 20; i++) await b.writeFile(`/f-${i}.txt`, `edited-${i}`);
  await measure("1000 files | 500 rm + 20 edits", 520, () => a.diffCount("b"));
}

async function benchNodeTypeFilter() {
  const ws = "bench-dc-nodetype";
  await resetWs(ws);
  const a = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "a",
    maxFiles: 3000,
  });
  await a.init();
  for (let i = 0; i < 500; i++) await a.writeFile(`/f-${i}.txt`, `c-${i}`);
  await a.mkdir("/d1", { recursive: true });
  await a.mkdir("/d2", { recursive: true });
  const b = await a.fork("b");
  // Mixed changes: 30 file edits, 10 new dirs, 5 new symlinks.
  for (let i = 0; i < 30; i++) await b.writeFile(`/f-${i}.txt`, `edited-${i}`);
  for (let i = 0; i < 10; i++) await b.mkdir(`/new-d-${i}`, { recursive: true });
  for (let i = 0; i < 5; i++) await b.symlink(`/f-${i}.txt`, `/link-${i}`);
  // Total changed: 30 file edits + 10 dirs + 5 symlinks = 45.
  // nodeType=file should match 30 + 5 (symlink replacing nothing has theirs.symlink, no file) = 30,
  // unless the replaced /link-* paths previously held files (they don't — they're new).
  await measure("500 files | 45 mixed (no filter)", 45, () => a.diffCount("b"));
  await measure("500 files | 45 mixed (nodeType=file)", 30, () =>
    a.diffCount("b", { nodeType: "file" }),
  );
}

async function benchDeepChain() {
  const ws = "bench-dc-chain";
  await resetWs(ws);
  let cur = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v0",
    maxFiles: 2000,
  });
  await cur.init();
  for (let i = 0; i < 500; i++) await cur.writeFile(`/f-${i}.txt`, `c-${i}`);
  for (let d = 1; d <= 25; d++) cur = await cur.fork(`v${d}`);
  // At v25, edit 20 files; diff vs sibling at v24's lineage.
  const sibling = await cur.fork("sibling");
  for (let i = 0; i < 20; i++) await sibling.writeFile(`/f-${i}.txt`, `edited-${i}`);
  await measure("depth 25 | 500 files | 20 edits at tip", 20, () =>
    cur.diffCount("sibling"),
  );
}

// -- Orchestration ---------------------------------------------------------

function writeResults(label: string) {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`\n## ${label}  _(${ts})_`);
  lines.push("");
  lines.push("| Scenario | Metric | Value |");
  lines.push("| --- | --- | --- |");
  for (const r of results) lines.push(`| ${r.scenario} | ${r.metric} | ${r.value} |`);
  const block = lines.join("\n") + "\n";
  if (!existsSync(OUTFILE)) writeFileSync(OUTFILE, "# diffCount bench results\n");
  appendFileSync(OUTFILE, block);
  console.log(`\nAppended results to ${OUTFILE}`);
}

async function main() {
  await setup(client, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });
  console.log(`Label: ${LABEL}  iterations=${ITERATIONS} warmup=${WARMUP}`);

  console.log("\n=== small ===");
  await benchSmallDiff();
  console.log("\n=== medium ===");
  await benchMediumDiff();
  console.log("\n=== large sparse ===");
  await benchLargeSparseDiff();
  console.log("\n=== tombstone heavy ===");
  await benchTombstoneHeavy();
  console.log("\n=== nodeType filter ===");
  await benchNodeTypeFilter();
  console.log("\n=== deep chain ===");
  await benchDeepChain();

  writeResults(LABEL);
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(e);
    await sql.end();
    process.exit(1);
  });
