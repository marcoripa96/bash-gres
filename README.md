# bash-gres

PostgreSQL-backed virtual filesystem for AI agents. Persistent, searchable file storage with familiar shell semantics powered by [just-bash](https://github.com/nichochar/just-bash).

## Features

- Full virtual filesystem (mkdir, cat, ls, cp, mv, rm, find, grep, tree, etc.)
- Workspace isolation via PostgreSQL Row-Level Security
- BM25 full-text search via `pg_textsearch`
- Optional pgvector semantic/hybrid search
- Compatible with [just-bash](https://github.com/nichochar/just-bash) — 60+ commands, pipes, redirects, variables, loops
- Bring your own driver: works with `postgres.js` or Drizzle ORM

## Install

```sh
npm install bash-gres just-bash
```

Then install one (or both) database drivers as peer dependencies:

```sh
# postgres.js
npm install postgres

# Drizzle ORM
npm install drizzle-orm
```

## Quick start

### With postgres.js

```ts
import postgres from "postgres";
import { createPostgresClient } from "bash-gres/postgres";
import { PgFileSystem, setup } from "bash-gres";
import { Bash } from "just-bash";

const sql = postgres("postgres://localhost:5432/mydb");
const client = createPostgresClient(sql);

await setup(client);

const fs = new PgFileSystem({ db: client, workspaceId: "my-workspace" });
await fs.init();

const bash = new Bash({ fs });

await bash.exec('echo "hello world" > /greeting.txt');
const cat = await bash.exec("cat /greeting.txt");
console.log(cat.stdout); // "hello world\n"
```

### With Drizzle

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDrizzleClient } from "bash-gres/drizzle";
import { PgFileSystem, setup } from "bash-gres";
import { Bash } from "just-bash";

const sql = postgres("postgres://localhost:5432/mydb");
const db = drizzle(sql);
const client = createDrizzleClient(db);

await setup(client);

const fs = new PgFileSystem({ db: client, workspaceId: "my-workspace" });
await fs.init();

const bash = new Bash({ fs });
await bash.exec("mkdir -p /project/src");
await bash.exec('echo "console.log(42)" > /project/src/index.ts');

const tree = await bash.exec("tree /project");
console.log(tree.stdout);
```

## Filesystem API

You can also use the filesystem directly without bash:

```ts
await fs.mkdir("/docs/notes", { recursive: true });
await fs.writeFile("/docs/notes/todo.txt", "Buy milk");

const content = await fs.readFile("/docs/notes/todo.txt");
const entries = await fs.readdir("/docs");
const stats = await fs.stat("/docs/notes/todo.txt");
```

## Database requirements

bash-gres requires PostgreSQL with the `ltree` extension. For full-text search, `pg_textsearch` v1.0.0+ is needed. For semantic search, `pgvector` is optional.

The `setup()` function is idempotent and creates the required table, indexes, and extensions automatically.

## Subpath exports

```
bash-gres            — PgFileSystem, setup(), types
bash-gres/postgres   — createPostgresClient (postgres.js adapter)
bash-gres/drizzle    — createDrizzleClient (Drizzle adapter)
```

## Development

```sh
docker compose up -d   # start postgres on localhost:5433
npm test               # run tests
npm run typecheck       # type check
npm run build          # compile to dist/
```

## License

[MIT](LICENSE)
