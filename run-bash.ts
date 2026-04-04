import postgres from "postgres";
import { createPostgresClient } from "./src/adapters/postgres/index.js";
import { setup } from "./src/core/setup.js";
import { PgFileSystem } from "./src/core/filesystem.js";
import { BashInterpreter } from "./src/core/bash.js";
import { createInterface } from "readline";

const sessionId = process.argv[2] || "manual-test";

const sql = postgres("postgres://postgres:postgres@localhost:5433/bashgres_test", {
  onnotice: () => {},
});
const client = createPostgresClient(sql);

await setup(client, {
  enableRLS: false,
  enableFullTextSearch: false,
  enableVectorSearch: false,
});

const fs = new PgFileSystem({ db: client, sessionId });
await fs.init();
const bash = new BashInterpreter(fs);

const rl = createInterface({ input: process.stdin, terminal: false });

for await (const line of rl) {
  const cmd = line.trim();
  if (!cmd || cmd.startsWith("#")) continue;
  console.log(`$ ${cmd}`);
  const r = await bash.execute(cmd);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(`ERR: ${r.stderr}`);
  if (r.exitCode !== 0) console.log(`[exit ${r.exitCode}]`);
}

await sql.end();
