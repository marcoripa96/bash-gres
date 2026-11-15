/**
 * How long writers wait on collectOrphanBlobs: one connection overwrites a
 * file in a loop while another collects ORPHANS orphaned blobs (2 KB, two
 * hours old) in batches of BATCH. Reports each batch DELETE's duration and
 * the writer's latency before and during the collection.
 *
 *   ORPHANS=20000 BATCH=1000 npx vite-node bench/collect-orphan-blobs.ts
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
const ORPHANS = Number(process.env["ORPHANS"] ?? 20_000);
const BATCH = Number(process.env["BATCH"] ?? 1000);
const FILES = Number(process.env["FILES"] ?? 2000);

const ms = (t0: bigint) => Number(hrtime.bigint() - t0) / 1e6;

function q(a: number[], p: number): string {
  if (a.length === 0) return "-";
  return [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!.toFixed(2);
}

/** Times the statements whose text matches `re`. */
function timing(inner: SqlClient, re: RegExp, out: number[]): SqlClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
      const t0 = hrtime.bigint();
      const r = await inner.query<T>(text, params);
      if (re.test(text)) out.push(ms(t0));
      return r;
    },
    transaction: (fn) => inner.transaction((tx) => fn(timing(tx, re, out))),
  };
}

async function main() {
  const sqlA = postgresLib(TEST_DB_URL, { onnotice: () => {}, max: 2 });
  const sqlB = postgresLib(TEST_DB_URL, { onnotice: () => {}, max: 1 });
  const a = createPostgresClient(sqlA);
  const b = createPostgresClient(sqlB);
  await setup(a, { enableRLS: false, enableFullTextSearch: false, enableVectorSearch: false });

  const ws = "bench-collect-orphans";
  for (const t of ["fs_entries", "version_ancestors", "fs_versions", "fs_version_roots", "fs_blobs"]) {
    await a.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
  }
  const fs = new PgFileSystem({ db: a, workspaceId: ws });
  await fs.init();
  for (let i = 0; i < FILES; i++) await fs.writeFile(`/files/f${i}.md`, `file ${i}\n`.repeat(50));
  await a.query(
    `INSERT INTO fs_blobs (workspace_id, hash, content, size_bytes, created_at)
     SELECT $1, sha256(convert_to('orphan ' || g, 'UTF8')),
            repeat('orphan ' || g || ' ', 200), 2000, now() - interval '2 hours'
     FROM generate_series(1, $2::int) g`,
    [ws, ORPHANS],
  );
  await a.query(`ANALYZE fs_blobs`);
  await a.query(`ANALYZE fs_entries`);

  const writer = new PgFileSystem({ db: b, workspaceId: ws });
  const write = async (i: number) => {
    const t0 = hrtime.bigint();
    await writer.writeFile("/live.md", `live ${i}\n`);
    return ms(t0);
  };
  const before: number[] = [];
  for (let i = 0; i < 300; i++) before.push(await write(i));

  const deletes: number[] = [];
  const collector = new PgFileSystem({ db: timing(a, /DELETE FROM fs_blobs/, deletes), workspaceId: ws });
  const during: number[] = [];
  let collecting = true;
  const loop = (async () => {
    let i = 0;
    while (collecting) during.push(await write(1000 + i++));
  })();
  const t0 = hrtime.bigint();
  const result = await collector.collectOrphanBlobs({ minAgeMs: 60_000, batchSize: BATCH });
  const total = ms(t0);
  collecting = false;
  await loop;

  console.log(`orphans ${ORPHANS}, referenced files ${FILES}, batchSize ${BATCH}`);
  console.log(`collect: ${JSON.stringify(result)} in ${total.toFixed(0)} ms`);
  console.log(`batch DELETE ms: median ${q(deletes, 0.5)} p95 ${q(deletes, 0.95)} max ${q(deletes, 1)}`);
  console.log(`writeFile ms before:  median ${q(before, 0.5)} p99 ${q(before, 0.99)} max ${q(before, 1)} (n=${before.length})`);
  console.log(`writeFile ms during:  median ${q(during, 0.5)} p99 ${q(during, 0.99)} max ${q(during, 1)} (n=${during.length})`);

  await sqlA.end();
  await sqlB.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
