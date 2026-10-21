/**
 * Read-API sweep: every read call once, measured with the built-in tracer
 * (statements sent, median wall time), on a read-only instance. Round-trip
 * counts are the cost against a remote database, so run it with --rtt.
 *
 * Use a database of its own: the search cases need the vector table at
 * EMBED_DIM dimensions, and setup() never alters an existing one (the test
 * database's is 3-dimensional).
 *
 *   docker compose up -d
 *   docker compose exec postgres createdb -U postgres bashgres_sweep
 *   export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/bashgres_sweep
 *   npm run bench:read-api -- --seed           # once
 *   npm run bench:read-api -- --rtt 0.5
 *
 * Flags: --seed (load this repo's files with chunking + a deterministic
 * fake embedder, fork "crawl", embed), --rtt <ms>, --reps <n> (default 7),
 * --driver bun-drizzle (run with bun). Env: TEST_DATABASE_URL, POOL,
 * PREPARE=1, EMBED_DIM (default 1024, webble's), BENCH_OUTPUT.
 */
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import type { PgFileSystemOptions, TraceEvent } from "../lib/core/types.js";
import { connect, startLatencyProxy, type BenchDriver } from "./connection.js";

const WORKSPACE = "bench-read-api";
const SEED_DIRS = ["lib", "tests", "bench", "examples"];
const SEED_FILES = ["README.md", "CLAUDE.md", "package.json", "FOLLOWUPS.md"];

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const reps = Number(option("--reps") ?? 7);
const rttOneWayMs = option("--rtt");
const driver: BenchDriver =
  option("--driver") === "bun-drizzle" ? "bun-drizzle" : "postgres";
const pool = Number(process.env["POOL"] ?? 10);
const dims = Number(process.env["EMBED_DIM"] ?? 1024);
const dbUrl = new URL(
  process.env["TEST_DATABASE_URL"] ??
    "postgres://postgres:postgres@localhost:5434/bashgres_sweep",
);
const now = performance.now.bind(performance);

/** Hashed bag of words: deterministic, and similar text lands nearby. */
async function fakeEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    const v = new Array<number>(dims).fill(0);
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (!word) continue;
      let h = 0;
      for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      v[h % dims]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

async function seed(options: PgFileSystemOptions): Promise<number> {
  await setup(options.db, {
    enableRLS: false,
    enableFullTextSearch: true,
    enableVectorSearch: true,
    embeddingDimensions: dims,
  });
  for (const table of [
    "fs_entries",
    "version_ancestors",
    "fs_versions",
    "fs_version_roots",
    "fs_blobs",
  ]) {
    await options.db.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [
      WORKSPACE,
    ]);
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|md|json)$/.test(name)) files.push(full);
    }
  };
  for (const d of SEED_DIRS) walk(d);
  files.push(...SEED_FILES);
  const fs = new PgFileSystem(options);
  await fs.init();
  await fs.transaction(async (tx) => {
    for (const f of files) {
      const target = "/repo/" + relative(".", f);
      await tx.mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true });
      await tx.writeFile(target, readFileSync(f, "utf8"));
    }
  });
  await fs.symlink("/repo/lib/core/mounts.ts", "/repo/mounts-link.ts");
  await fs.fork("crawl");
  await fs.indexChunkEmbeddings();
  await options.db.query("ANALYZE");
  return files.length;
}

async function main() {
  const proxy =
    rttOneWayMs === undefined
      ? null
      : await startLatencyProxy(dbUrl, rttOneWayMs, 15436);
  const conn = await connect(proxy?.url ?? dbUrl, driver, pool);
  try {
    let events: TraceEvent[] | null = null;
    const trace = (e: TraceEvent) => events?.push(e);
    const base: PgFileSystemOptions = {
      db: conn.client,
      workspaceId: WORKSPACE,
      maxFiles: 20_000,
      chunking: true,
      embed: fakeEmbed,
      embeddingDimensions: dims,
    };
    if (args.includes("--seed")) {
      console.log(`seeded ${await seed(base)} files into ${WORKSPACE}:/repo`);
    }
    const ro = new PgFileSystem({ ...base, permissions: { write: false }, trace });
    await ro.exists("/"); // resolve and cache the version id once

    const cases: Array<[string, () => Promise<unknown>]> = [
      ["exists (missing)", () => ro.exists("/usr/bin/cat")],
      ["stat", () => ro.stat("/repo/lib/core/mounts.ts")],
      ["stat via symlink", () => ro.stat("/repo/mounts-link.ts")],
      ["realpath", () => ro.realpath("/repo/mounts-link.ts")],
      ["readFile", () => ro.readFile("/repo/lib/core/mounts.ts")],
      ["readFile via symlink", () => ro.readFile("/repo/mounts-link.ts")],
      ["readFileBuffer", () => ro.readFileBuffer("/repo/lib/core/mounts.ts")],
      ["readFileRange 4 KiB", () => ro.readFileRange("/repo/lib/core/filesystem.ts", { offset: 1000, limit: 4096 })],
      ["readFileLines 40", () => ro.readFileLines("/repo/lib/core/filesystem.ts", { offset: 100, limit: 40 })],
      ["readFileChunks", () => ro.readFileChunks("/repo/README.md")],
      ["readdir lib/core", () => ro.readdir("/repo/lib/core")],
      ["readdirWithStats lib/core", () => ro.readdirWithStats("/repo/lib/core")],
      ["walk /repo/lib", () => ro.walk("/repo/lib")],
      ["walk /repo", () => ro.walk("/repo")],
      ["glob **/*.ts", () => ro.glob("**/*.ts", { cwd: "/repo" })],
      ["glob lib/core/*.ts", () => ro.glob("lib/core/*.ts", { cwd: "/repo" })],
      ["textSearch", () => ro.textSearch("coalesce batch query")],
      ["semanticSearch", () => ro.semanticSearch("how are concurrent reads batched")],
      ["hybridSearch", () => ro.hybridSearch("how are concurrent reads batched")],
      ["listVersions", () => ro.listVersions()],
      ["getLastModified", () => ro.getLastModified()],
      ["getUsage", () => ro.getUsage()],
      ["listHistory 20", () => ro.listHistory({ limit: 20 })],
      ["diff vs crawl", () => ro.diff("crawl")],
      [
        "fresh instance + first read",
        () =>
          new PgFileSystem({ ...base, permissions: { write: false }, trace }).readFile(
            "/repo/README.md",
          ),
      ],
      [
        // webble's openWorkspace(): seed instance + init() + listVersions(),
        // then a read-only instance on the picked version.
        "open-per-request pattern",
        async () => {
          const seedFs = new PgFileSystem({ db: conn.client, workspaceId: WORKSPACE, trace });
          await seedFs.init();
          const versions = await seedFs.listVersions();
          const fs = new PgFileSystem({
            ...base,
            permissions: { write: false },
            version: versions.includes("crawl") ? "crawl" : undefined,
            trace,
          });
          return fs.readFile("/repo/README.md");
        },
      ],
    ];

    const label = [
      driver,
      rttOneWayMs === undefined ? "loopback" : `+${rttOneWayMs} ms one-way`,
      `pool ${pool}`,
      process.env["PREPARE"] === "1" ? "prepared" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const lines = [
      `### read API sweep: ${label}`,
      "",
      "| Call | Statements | Median ms |",
      "| --- | ---: | ---: |",
    ];
    for (const [name, run] of cases) {
      await run(); // warm
      const times: number[] = [];
      let statements = 0;
      for (let r = 0; r < reps; r++) {
        const collected: TraceEvent[] = [];
        events = collected;
        const t0 = now();
        await run();
        times.push(now() - t0);
        events = null;
        statements = collected.filter((e) => e.type === "query").length;
      }
      times.sort((a, b) => a - b);
      lines.push(
        `| ${name} | ${statements} | ${times[Math.floor(times.length / 2)]!.toFixed(2)} |`,
      );
    }
    lines.push("");
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
