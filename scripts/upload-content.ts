import { PgFileSystem } from "../lib/core/filesystem.js";
import { setup } from "../lib/core/setup.js";
import { createPostgresClient } from "../lib/adapters/postgres/index.js";
import postgres from "postgres";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const DB_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/bashgres_test";
const CONTENT_DIR = new URL("../content", import.meta.url).pathname;

async function* walkDir(dir: string): AsyncGenerator<{ path: string; isDir: boolean }> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield { path: full, isDir: true };
      yield* walkDir(full);
    } else {
      yield { path: full, isDir: false };
    }
  }
}

async function main() {
  const sql = postgres(DB_URL, { onnotice: () => {} });
  const client = createPostgresClient(sql);

  await setup(client, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });

  const fs = new PgFileSystem({ db: client, workspaceId: "content-upload" });
  await fs.init();

  let dirs = 0;
  let files = 0;

  for await (const entry of walkDir(CONTENT_DIR)) {
    const rel = "/" + relative(CONTENT_DIR, entry.path);

    if (entry.isDir) {
      await fs.mkdir(rel, { recursive: true });
      dirs++;
      if (dirs % 20 === 0) console.log(`  created ${dirs} directories...`);
    } else {
      const content = await readFile(entry.path, "utf-8");
      await fs.writeFile(rel, content);
      files++;
      if (files % 50 === 0) console.log(`  uploaded ${files} files...`);
    }
  }

  console.log(`Done: ${dirs} directories, ${files} files uploaded.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
