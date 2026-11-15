/**
 * Round trips and latency of an overwrite: plain writeFile against
 * writeFileWithBase with a matching base (the fast path), a mismatching base
 * settled by a resolver (the slow path), and inside fs.transaction().
 *
 *   npx tsc -p tsconfig.bench.json && node dist-bench/bench/write-with-base.js
 *
 * ITER (default 500) overwrites per case; the median and p95 are reported.
 */
import { hrtime } from "node:process";
import postgresLib from "postgres";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type { SqlClient, SqlParam, QueryResult } from "../lib/core/types.js";

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5434/bashgres_test";
const ITER = Number(process.env["ITER"] ?? 500);

/** Counts statements, counting a transaction as BEGIN + COMMIT. */
function counting(inner: SqlClient, counter: { n: number }): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: SqlParam[] = [],
    ): Promise<QueryResult<T>> {
      counter.n++;
      return inner.query<T>(text, params);
    },
    async transaction<U>(fn: (client: SqlClient) => Promise<U>): Promise<U> {
      counter.n += 2;
      return inner.transaction((tx) => fn(counting(tx, counter)));
    },
  };
}

function stats(ms: number[]): { median: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)]!,
    p95: s[Math.floor(s.length * 0.95)]!,
  };
}

async function measure(
  label: string,
  counter: { n: number },
  op: (i: number) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < 20; i++) await op(-1 - i); // warm-up
  const times: number[] = [];
  counter.n = 0;
  for (let i = 0; i < ITER; i++) {
    const t0 = hrtime.bigint();
    await op(i);
    times.push(Number(hrtime.bigint() - t0) / 1_000_000);
  }
  const { median, p95 } = stats(times);
  console.log(
    `${label.padEnd(44)} round trips/op ${(counter.n / ITER).toFixed(2).padStart(5)}` +
      `  median ${median.toFixed(3)} ms  p95 ${p95.toFixed(3)} ms`,
  );
}

async function main() {
  const sql = postgresLib(TEST_DB_URL, { onnotice: () => {}, max: 1 });
  const base = createPostgresClient(sql);
  await setup(base, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });

  const ws = "bench-write-with-base";
  for (const t of ["fs_entries", "version_ancestors", "fs_versions", "fs_version_roots", "fs_blobs"]) {
    await base.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
  }

  const counter = { n: 0 };
  const fs = new PgFileSystem({ db: counting(base, counter), workspaceId: ws });
  await fs.init();
  await fs.writeFile("/doc.md", "start");

  const text = (i: number) => `# Report\n\nrevision ${i}\n${"lorem ipsum ".repeat(40)}\n`;

  await measure("writeFile (overwrite)", counter, (i) =>
    fs.writeFile("/doc.md", text(i)),
  );

  const hasWithBase = typeof (fs as { writeFileWithBase?: unknown }).writeFileWithBase === "function";
  if (!hasWithBase) {
    console.log("writeFileWithBase: not in this build");
  } else {
    let current = text(-1);
    await fs.writeFile("/doc.md", current);
    await measure("writeFileWithBase, base matches (by content)", counter, async (i) => {
      const next = text(i) + "a";
      await fs.writeFileWithBase("/doc.md", next, { base: { content: current } });
      current = next;
    });
    const { contentHash } = await import("../lib/core/index.js");
    await measure("writeFileWithBase, base matches (by hash)", counter, async (i) => {
      const next = text(i) + "b";
      await fs.writeFileWithBase("/doc.md", next, { base: { hash: contentHash(current) } });
      current = next;
    });
    await measure("writeFileWithBase, mismatch + resolver", counter, async (i) => {
      const next = text(i) + "c";
      await fs.writeFileWithBase("/doc.md", next, {
        base: { content: "stale" },
        resolve: () => ({ content: next }),
      });
      current = next;
    });
    await measure("writeFileWithBase inside fs.transaction()", counter, async (i) => {
      const next = text(i) + "d";
      await fs.transaction((tx) =>
        tx.writeFileWithBase("/doc.md", next, { base: { content: current } }),
      );
      current = next;
    });
  }
  await measure("writeFile inside fs.transaction()", counter, (i) =>
    fs.transaction((tx) => tx.writeFile("/doc.md", text(i) + "e")),
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
