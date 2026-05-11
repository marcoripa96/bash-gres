/**
 * Performance benchmark for bash-gres.
 *
 * Uses only the public PgFileSystem API so it runs unchanged on both `main`
 * (full-copy fork model) and `cow-redesign` (content-addressed COW). Reset
 * helpers tolerate both schemas via try/catch.
 *
 * Run:
 *   docker compose up -d
 *   BENCH_LABEL=cow-redesign npm run bench
 *
 * Output: markdown table to stdout. If BENCH_OUTPUT is set, appends the same
 * table (with a branch heading) to that file so cross-branch runs accumulate.
 */
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { hrtime } from "node:process";
import postgresLib from "postgres";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type { SqlClient } from "../lib/core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5433/bashgres_test";

const LABEL = process.env["BENCH_LABEL"] ?? "unlabeled";
const OUTFILE = process.env["BENCH_OUTPUT"] ?? "bench/results.md";

const sql = postgresLib(TEST_DB_URL, { onnotice: () => {} });
const client = createPostgresClient(sql);

interface Result {
  scenario: string;
  metric: string;
  value: string;
}

type HistoryCapableFs = PgFileSystem & {
  listHistory?: (opts?: {
    limit?: number;
    cursor?: string;
    includeRoot?: boolean;
    includeChanges?: boolean | "paths";
  }) => Promise<{
    entries: Array<{ versionId: number; parentVersionId: number | null }>;
    nextCursor: string | null;
  }>;
  versionDiff?: (
    versionId: number,
    opts?: { path?: string },
  ) => Promise<unknown[]>;
  sweepHistory?: () => Promise<unknown>;
};

const results: Result[] = [];

function record(scenario: string, metric: string, value: string) {
  results.push({ scenario, metric, value });
  console.log(`  ${scenario.padEnd(40)} ${metric.padEnd(20)} ${value}`);
}

async function detectSchema(): Promise<"old" | "new" | "none"> {
  const r = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('fs_nodes', 'fs_blobs', 'fs_entries', 'fs_versions')`,
  );
  const names = new Set(r.rows.map((row) => row.table_name));
  if (names.has("fs_blobs") && names.has("fs_entries")) return "new";
  if (names.has("fs_nodes")) return "old";
  return "none";
}

async function resetWs(workspaceId: string, schema: "old" | "new") {
  if (schema === "old") {
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [
      workspaceId,
    ]);
  } else {
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
}

async function totalBytes(schema: "old" | "new"): Promise<number> {
  if (schema === "old") {
    const r = await client.query<{ bytes: number }>(
      `SELECT pg_total_relation_size('fs_nodes')::bigint AS bytes`,
    );
    return Number(r.rows[0]!.bytes);
  }
  const r = await client.query<{ bytes: number }>(
    `SELECT (
       pg_total_relation_size('fs_blobs')
       + pg_total_relation_size('fs_entries')
       + pg_total_relation_size('fs_versions')
       + pg_total_relation_size('version_ancestors')
     )::bigint AS bytes`,
  );
  return Number(r.rows[0]!.bytes);
}

async function workspaceBytes(
  schema: "old" | "new",
  workspaceId: string,
): Promise<{ rows: number; rowsBlobs: number }> {
  if (schema === "old") {
    const r = await client.query<{ rows: number }>(
      `SELECT COUNT(*)::int AS rows FROM fs_nodes WHERE workspace_id = $1`,
      [workspaceId],
    );
    return { rows: Number(r.rows[0]!.rows), rowsBlobs: 0 };
  }
  const e = await client.query<{ rows: number }>(
    `SELECT COUNT(*)::int AS rows FROM fs_entries WHERE workspace_id = $1`,
    [workspaceId],
  );
  const b = await client.query<{ rows: number }>(
    `SELECT COUNT(*)::int AS rows FROM fs_blobs WHERE workspace_id = $1`,
    [workspaceId],
  );
  return {
    rows: Number(e.rows[0]!.rows),
    rowsBlobs: Number(b.rows[0]!.rows),
  };
}

function ms(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function fmtMs(ns: bigint): string {
  return `${ms(ns).toFixed(2)} ms`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MiB`;
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

// -- Scenarios --------------------------------------------------------------

async function benchForkAtScale(schema: "old" | "new") {
  const ws = "bench-fork-scale";
  for (const N of [100, 1000, 5000]) {
    await resetWs(ws, schema);
    const v1 = new PgFileSystem({
      db: client,
      workspaceId: ws,
      version: "v1",
      maxFiles: N + 100,
    });
    await v1.init();
    for (let i = 0; i < N; i++) {
      await v1.writeFile(`/file-${i}.txt`, `content-${i}`);
    }
    const { ns } = await time(() => v1.fork(`forked-${N}`));
    record(`fork after ${N} files`, "fork()", fmtMs(ns));
  }
}

async function benchReadAtChainDepth(schema: "old" | "new") {
  // Old branch: linear chain of forks, file written at v0 visible at vN via N row copies.
  // New branch: linear chain, file inserted only at v0; reads at vN walk closure.
  const ws = "bench-read-depth";
  for (const D of [1, 5, 25, 50]) {
    await resetWs(ws, schema);
    let fs = new PgFileSystem({
      db: client,
      workspaceId: ws,
      version: `v0`,
    });
    await fs.init();
    await fs.writeFile("/origin.txt", "the-content");
    for (let d = 1; d <= D; d++) {
      fs = await fs.fork(`v${d}`);
    }
    // Warm-up
    for (let i = 0; i < 5; i++) await fs.readFile("/origin.txt");
    const samples: bigint[] = [];
    for (let i = 0; i < 100; i++) {
      const { ns } = await time(() => fs.readFile("/origin.txt"));
      samples.push(ns);
    }
    record(
      `read at depth ${D}`,
      "median",
      fmtMs(median(samples)),
    );
    record(
      `read at depth ${D}`,
      "p95",
      fmtMs(p95(samples)),
    );
  }
}

async function benchStorageAfterForkPlusEdit(schema: "old" | "new") {
  const ws = "bench-storage";
  await resetWs(ws, schema);

  const N = 1000;
  const v1 = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v1",
    maxFiles: N + 100,
  });
  await v1.init();
  for (let i = 0; i < N; i++) {
    await v1.writeFile(`/file-${i}.txt`, `content-${i}`);
  }

  const before = await workspaceBytes(schema, ws);
  const totalBefore = await totalBytes(schema);

  const v2 = await v1.fork("v2");
  // Mutate exactly one file in v2.
  await v2.writeFile("/file-0.txt", "edited-in-v2");

  const after = await workspaceBytes(schema, ws);
  const totalAfter = await totalBytes(schema);

  record(
    `storage: ${N} files, fork+1 edit`,
    "entry/node rows",
    `${before.rows} -> ${after.rows}`,
  );
  if (schema === "new") {
    record(
      `storage: ${N} files, fork+1 edit`,
      "blob rows",
      `${before.rowsBlobs} -> ${after.rowsBlobs}`,
    );
  }
  record(
    `storage: ${N} files, fork+1 edit`,
    "total bytes (whole DB)",
    `${fmtBytes(totalBefore)} -> ${fmtBytes(totalAfter)} (Δ ${fmtBytes(totalAfter - totalBefore)})`,
  );
}

async function benchDeleteVersionGC(schema: "old" | "new") {
  const ws = "bench-delete";
  await resetWs(ws, schema);

  const N = 1000;
  const v1 = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v1",
    maxFiles: N + 100,
  });
  await v1.init();
  for (let i = 0; i < N; i++) {
    await v1.writeFile(`/file-${i}.txt`, `content-${i}`);
  }
  const v2 = await v1.fork("v2");
  // Edit ~10% in v2 so deleteVersion has real GC work to do.
  for (let i = 0; i < 100; i++) {
    await v2.writeFile(`/file-${i}.txt`, `edited-${i}`);
  }

  const { ns } = await time(() => v1.deleteVersion("v2"));
  record(`deleteVersion (1000 files, 100 edited)`, "elapsed", fmtMs(ns));
}

async function benchPromoteDropPrevious(schema: "old" | "new") {
  if (schema !== "new") return;
  const ws = "bench-promote-drop-previous";
  await resetWs(ws, schema);

  const N = 1000;
  const main = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "main",
    maxFiles: N + 200,
  });
  await main.init();
  for (let i = 0; i < N; i++) {
    await main.writeFile(`/file-${i}.txt`, `content-${i}`);
  }
  const exp = await main.fork("exp");
  for (let i = 0; i < 100; i++) {
    await exp.writeFile(`/file-${i}.txt`, `edited-${i}`);
  }

  const { ns } = await time(() => exp.promoteTo("main", { dropPrevious: true }));
  record("promoteTo dropPrevious (1000 files, 100 edited)", "elapsed", fmtMs(ns));
}

async function benchDirListingUnderDivergence(schema: "old" | "new") {
  const ws = "bench-listing";
  await resetWs(ws, schema);

  // Directory of 100 files at v0; each fork edits 5 different files.
  const v0 = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v0",
  });
  await v0.init();
  await v0.mkdir("/d", { recursive: true });
  for (let i = 0; i < 100; i++) {
    await v0.writeFile(`/d/f${i}.txt`, `c${i}`);
  }

  let fs: PgFileSystem = v0;
  for (let d = 1; d <= 10; d++) {
    fs = await fs.fork(`v${d}`);
    for (let i = (d - 1) * 5; i < d * 5; i++) {
      await fs.writeFile(`/d/f${i}.txt`, `edited-at-v${d}-${i}`);
    }
  }

  // Warm-up
  for (let i = 0; i < 5; i++) await fs.readdir("/d");
  const samples: bigint[] = [];
  for (let i = 0; i < 50; i++) {
    const { ns } = await time(() => fs.readdir("/d"));
    samples.push(ns);
  }
  record(`readdir(/d) at depth 10, 100 files`, "median", fmtMs(median(samples)));
  record(`readdir(/d) at depth 10, 100 files`, "p95", fmtMs(p95(samples)));
}

async function benchSliceReads(schema: "old" | "new") {
  const ws = "bench-slice-reads";
  await resetWs(ws, schema);

  const fs = new PgFileSystem({ db: client, workspaceId: ws, version: "v0" });
  await fs.init();

  const textLines: string[] = [];
  for (let i = 0; i < 200; i++) textLines.push(`line-${i.toString().padStart(4, "0")}`);
  const text = textLines.join("\n") + "\n";
  await fs.writeFile("/text.log", text);

  const binary = new Uint8Array(8 * 1024);
  for (let i = 0; i < binary.length; i++) binary[i] = i & 0xff;
  await fs.writeFile("/blob.bin", binary);

  // readFileBuffer (text)
  for (let i = 0; i < 5; i++) await fs.readFileBuffer("/text.log");
  let samples: bigint[] = [];
  for (let i = 0; i < 100; i++) {
    const { ns } = await time(() => fs.readFileBuffer("/text.log"));
    samples.push(ns);
  }
  record("readFileBuffer (text, 200 lines)", "median", fmtMs(median(samples)));
  record("readFileBuffer (text, 200 lines)", "p95", fmtMs(p95(samples)));

  // readFileBuffer (binary)
  for (let i = 0; i < 5; i++) await fs.readFileBuffer("/blob.bin");
  samples = [];
  for (let i = 0; i < 100; i++) {
    const { ns } = await time(() => fs.readFileBuffer("/blob.bin"));
    samples.push(ns);
  }
  record("readFileBuffer (binary, 8 KiB)", "median", fmtMs(median(samples)));
  record("readFileBuffer (binary, 8 KiB)", "p95", fmtMs(p95(samples)));

  // readFileRange (small slice)
  for (let i = 0; i < 5; i++) await fs.readFileRange("/blob.bin", { offset: 0, limit: 64 });
  samples = [];
  for (let i = 0; i < 100; i++) {
    const { ns } = await time(() =>
      fs.readFileRange("/blob.bin", { offset: 1024, limit: 64 }),
    );
    samples.push(ns);
  }
  record("readFileRange (8 KiB, 64 B slice)", "median", fmtMs(median(samples)));
  record("readFileRange (8 KiB, 64 B slice)", "p95", fmtMs(p95(samples)));

  // readFileLines (10-line slice)
  for (let i = 0; i < 5; i++) await fs.readFileLines("/text.log", { offset: 50, limit: 10 });
  samples = [];
  for (let i = 0; i < 100; i++) {
    const { ns } = await time(() =>
      fs.readFileLines("/text.log", { offset: 50, limit: 10 }),
    );
    samples.push(ns);
  }
  record("readFileLines (200 lines, 10-line slice)", "median", fmtMs(median(samples)));
  record("readFileLines (200 lines, 10-line slice)", "p95", fmtMs(p95(samples)));
}

async function benchReadOnlyOps(schema: "old" | "new") {
  const ws = "bench-readonly-ops";
  await resetWs(ws, schema);

  const fs = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v0",
    maxFiles: 1100,
  });
  await fs.init();
  for (let i = 0; i < 50; i++) {
    await fs.writeFile(`/file-${i}.txt`, `content-${i}`);
  }
  let cur: PgFileSystem = fs;
  for (let d = 1; d <= 5; d++) cur = await cur.fork(`v${d}`);

  // listVersions
  for (let i = 0; i < 5; i++) await cur.listVersions();
  let samples: bigint[] = [];
  for (let i = 0; i < 100; i++) {
    const { ns } = await time(() => cur.listVersions());
    samples.push(ns);
  }
  record("listVersions (6 versions)", "median", fmtMs(median(samples)));
  record("listVersions (6 versions)", "p95", fmtMs(p95(samples)));

  // getUsage
  for (let i = 0; i < 5; i++) await cur.getUsage();
  samples = [];
  for (let i = 0; i < 50; i++) {
    const { ns } = await time(() => cur.getUsage());
    samples.push(ns);
  }
  record("getUsage (50 files, depth 5)", "median", fmtMs(median(samples)));
  record("getUsage (50 files, depth 5)", "p95", fmtMs(p95(samples)));

  // diff (cur vs sibling fork at v2)
  await cur.fork("sibling");
  for (let i = 0; i < 5; i++) await cur.diff("sibling");
  samples = [];
  for (let i = 0; i < 50; i++) {
    const { ns } = await time(() => cur.diff("sibling"));
    samples.push(ns);
  }
  record("diff (cur vs sibling, 50 files)", "median", fmtMs(median(samples)));
  record("diff (cur vs sibling, 50 files)", "p95", fmtMs(p95(samples)));
}

async function benchHistoryOps(schema: "old" | "new") {
  if (schema !== "new") return;
  const ws = "bench-history-ops";
  await resetWs(ws, schema);

  const root = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "main",
    maxFiles: 2000,
    historyRetention: "retain",
  }) as HistoryCapableFs;
  await root.init();
  for (let i = 0; i < 50; i++) {
    await root.writeFile(`/base-${i}.txt`, `base-${i}`);
  }

  let cur: HistoryCapableFs = root;
  for (let d = 1; d <= 20; d++) {
    cur = await cur.fork(`v${d}`) as HistoryCapableFs;
    await cur.writeFile(`/edit-${d}.txt`, `edit-${d}`);
  }
  if (!cur.listHistory || !cur.sweepHistory) return;

  for (let i = 0; i < 3; i++) await cur.listHistory({ limit: 20, includeChanges: false });
  let samples: bigint[] = [];
  for (let i = 0; i < 30; i++) {
    const { ns } = await time(() => cur.listHistory!({ limit: 20, includeChanges: false }));
    samples.push(ns);
  }
  record("listHistory metadata (20 versions)", "median", fmtMs(median(samples)));
  record("listHistory metadata (20 versions)", "p95", fmtMs(p95(samples)));

  for (let i = 0; i < 3; i++) await cur.listHistory({ limit: 20 });
  samples = [];
  for (let i = 0; i < 10; i++) {
    const { ns } = await time(() => cur.listHistory!({ limit: 20 }));
    samples.push(ns);
  }
  record("listHistory with changes (20 versions)", "median", fmtMs(median(samples)));
  record("listHistory with changes (20 versions)", "p95", fmtMs(p95(samples)));

  const { ns } = await time(() => cur.sweepHistory!());
  record("sweepHistory (21 active versions)", "elapsed", fmtMs(ns));
}

async function benchHistoryPagination1000(schema: "old" | "new") {
  if (schema !== "new") return;
  const ws = "bench-history-1000";
  await resetWs(ws, schema);

  let fs = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v0",
    maxFiles: 3000,
    historyRetention: "retain",
    statementTimeoutMs: 60_000,
  }) as HistoryCapableFs;
  await fs.init();
  await fs.writeFile("/v0.txt", "v0");
  for (let i = 1; i <= 1000; i++) {
    fs = await fs.fork(`v${i}`) as HistoryCapableFs;
    await fs.writeFile(`/v${i}.txt`, `v${i}`);
  }
  if (!fs.listHistory) return;

  const { result: firstPage, ns: firstPageNs } = await time(() =>
    fs.listHistory!({ limit: 100, includeChanges: false }),
  );
  const firstPageResult = firstPage as { nextCursor: string | null };
  record("listHistory metadata first page (100/1001)", "elapsed", fmtMs(firstPageNs));

  let cursor: string | null = null;
  let pages = 0;
  let entries = 0;
  const { ns: allMetadataNs } = await time(async () => {
    do {
      const page = await fs.listHistory!({
        limit: 100,
        cursor: cursor ?? undefined,
        includeChanges: false,
      }) as { entries: unknown[]; nextCursor: string | null };
      pages++;
      entries += page.entries.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
  });
  record("listHistory metadata all pages (1001)", "elapsed", fmtMs(allMetadataNs));
  record("listHistory metadata all pages (1001)", "pages", String(pages));
  record("listHistory metadata all pages (1001)", "entries", String(entries));

  const { ns: firstChangesNs } = await time(() =>
    fs.listHistory!({ limit: 100, includeChanges: true }),
  );
  record("listHistory changes first page (100/1001)", "elapsed", fmtMs(firstChangesNs));
  record(
    "listHistory metadata first page (100/1001)",
    "has nextCursor",
    String(firstPageResult.nextCursor !== null),
  );

  // paths-mode: cheap path+kind summary per row
  const { ns: firstPathsNs } = await time(() =>
    fs.listHistory!({ limit: 100, includeChanges: "paths" }),
  );
  record("listHistory paths first page (100/1001)", "elapsed", fmtMs(firstPathsNs));

  cursor = null;
  let pathsPages = 0;
  let pathsEntries = 0;
  const { ns: allPathsNs } = await time(async () => {
    do {
      const page = await fs.listHistory!({
        limit: 100,
        cursor: cursor ?? undefined,
        includeChanges: "paths",
      });
      pathsPages++;
      pathsEntries += page.entries.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
  });
  record("listHistory paths all pages (1001)", "elapsed", fmtMs(allPathsNs));
  record("listHistory paths all pages (1001)", "pages", String(pathsPages));
  record("listHistory paths all pages (1001)", "entries", String(pathsEntries));

  // versionDiff: simulate "user clicks on a single entry"
  if (fs.versionDiff) {
    const headPage = await fs.listHistory!({ limit: 1, includeChanges: false });
    const headEntry = headPage.entries[0]!;
    for (let i = 0; i < 3; i++) await fs.versionDiff(headEntry.versionId);
    const samples: bigint[] = [];
    for (let i = 0; i < 30; i++) {
      const { ns } = await time(() => fs.versionDiff!(headEntry.versionId));
      samples.push(ns);
    }
    record("versionDiff (single hop, head)", "median", fmtMs(median(samples)));
    record("versionDiff (single hop, head)", "p95", fmtMs(p95(samples)));

    // Also time the root entry: full visible-tree-as-added path.
    let rootCursor: string | null = null;
    let rootEntry: { versionId: number; parentVersionId: number | null } | undefined;
    let rootPage: {
      entries: Array<{ versionId: number; parentVersionId: number | null }>;
      nextCursor: string | null;
    };
    do {
      rootPage = await fs.listHistory!({
        limit: 200,
        cursor: rootCursor ?? undefined,
        includeChanges: false,
      });
      rootEntry = rootPage.entries.find(
        (e: { parentVersionId: number | null }) => e.parentVersionId === null,
      );
      rootCursor = rootPage.nextCursor;
    } while (!rootEntry && rootCursor !== null);
    if (rootEntry) {
      const { ns: rootNs } = await time(() => fs.versionDiff!(rootEntry!.versionId));
      record("versionDiff (root, full visible tree)", "elapsed", fmtMs(rootNs));
    }
  }
}

async function benchWriteFile(schema: "old" | "new") {
  const ws = "bench-writefile";
  await resetWs(ws, schema);

  const fs = new PgFileSystem({
    db: client,
    workspaceId: ws,
    version: "v0",
    maxFiles: 5000,
  });
  await fs.init();
  await fs.mkdir("/d", { recursive: true });

  // Cold writes: 50 fresh paths (no existing entry).
  let samples: bigint[] = [];
  for (let i = 0; i < 50; i++) {
    const { ns } = await time(() =>
      fs.writeFile(`/d/cold-${i}.txt`, `cold-${i}`),
    );
    samples.push(ns);
  }
  record("writeFile (new file in existing dir)", "median", fmtMs(median(samples)));
  record("writeFile (new file in existing dir)", "p95", fmtMs(p95(samples)));

  // Warm writes: overwrite existing path.
  for (let i = 0; i < 5; i++) await fs.writeFile("/d/warm.txt", "v0");
  samples = [];
  for (let i = 0; i < 100; i++) {
    const { ns } = await time(() =>
      fs.writeFile("/d/warm.txt", `iteration-${i}`),
    );
    samples.push(ns);
  }
  record("writeFile (overwrite existing)", "median", fmtMs(median(samples)));
  record("writeFile (overwrite existing)", "p95", fmtMs(p95(samples)));
}

// -- Orchestration ---------------------------------------------------------

function printHeader(title: string) {
  console.log(`\n=== ${title} ===`);
}

function writeResults(label: string) {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`\n## ${label}  _(${ts})_`);
  lines.push("");
  lines.push("| Scenario | Metric | Value |");
  lines.push("| --- | --- | --- |");
  for (const r of results) {
    lines.push(`| ${r.scenario} | ${r.metric} | ${r.value} |`);
  }
  const block = lines.join("\n") + "\n";

  if (!existsSync(OUTFILE)) {
    writeFileSync(OUTFILE, "# bash-gres bench results\n");
  }
  appendFileSync(OUTFILE, block);
  console.log(`\nAppended results to ${OUTFILE}`);
}

async function main() {
  // setup is idempotent
  await setup(client, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });

  const schema = await detectSchema();
  if (schema === "none") {
    throw new Error("No schema detected; run setup first.");
  }
  console.log(`Detected schema: ${schema} (label: ${LABEL})`);

  printHeader("fork at scale");
  await benchForkAtScale(schema);

  printHeader("read latency vs chain depth");
  await benchReadAtChainDepth(schema);

  printHeader("storage after fork + single edit");
  await benchStorageAfterForkPlusEdit(schema);

  printHeader("deleteVersion + GC");
  await benchDeleteVersionGC(schema);

  printHeader("promoteTo dropPrevious");
  await benchPromoteDropPrevious(schema);

  printHeader("readdir under version divergence");
  await benchDirListingUnderDivergence(schema);

  printHeader("slice reads (Buffer/Range/Lines)");
  await benchSliceReads(schema);

  printHeader("read-only ops (listVersions/getUsage/diff)");
  await benchReadOnlyOps(schema);

  printHeader("history ops");
  await benchHistoryOps(schema);

  if (process.env["BENCH_HISTORY_1000"] === "1") {
    printHeader("history pagination 1000");
    await benchHistoryPagination1000(schema);
  }

  printHeader("writeFile latency");
  await benchWriteFile(schema);

  writeResults(LABEL);
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(e);
    await sql.end();
    process.exit(1);
  });
