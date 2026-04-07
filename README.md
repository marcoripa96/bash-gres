# bash-gres

PostgreSQL-backed virtual filesystem for AI agents. Implements the [just-bash](https://github.com/vercel-labs/just-bash) `IFileSystem` interface, so you can pass it directly to `new Bash({ fs })` and get a complete bash environment backed by PostgreSQL.

## Features

- Full bash environment via [just-bash](https://github.com/vercel-labs/just-bash): 60+ commands, pipes, redirects, variables, loops
- Node.js `fs`-compatible API: readFile, writeFile, mkdir, cp, mv, rm, symlink, stat, walk, glob
- Workspace isolation via PostgreSQL Row-Level Security
- BM25 full-text search via `pg_textsearch`
- Optional pgvector semantic and hybrid search
- Bring your own driver: `postgres.js` or Drizzle ORM

## Install

```sh
npm install bash-gres
```

Then install your database driver and just-bash:

```sh
# postgres.js
npm install postgres just-bash

# Drizzle ORM
npm install drizzle-orm just-bash
```

## Quick Start

```ts
import postgres from "postgres"
import { Bash } from "just-bash"
import { setup, PgFileSystem } from "bash-gres/postgres"

const sql = postgres("postgres://localhost:5432/myapp")
await setup(sql)

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\n", stderr: "" }
```

### With Drizzle ORM

```ts
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { setup, PgFileSystem } from "bash-gres/drizzle"

const sql = postgres("postgres://localhost:5432/myapp")
const db = drizzle(sql)

await setup(db)

const fs = new PgFileSystem({ db, workspaceId: "workspace-1" })
```

## Filesystem API

```ts
await fs.writeFile("/docs/guide.md", "# Getting Started")
await fs.mkdir("/docs/images", { recursive: true })
const content = await fs.readFile("/docs/guide.md")
const entries = await fs.readdir("/docs")

await fs.cp("/docs", "/backup", { recursive: true })
await fs.mv("/backup/guide.md", "/archive/guide.md")
await fs.rm("/archive", { recursive: true, force: true })

await fs.symlink("/docs/guide.md", "/latest")
const stat = await fs.stat("/docs/guide.md")
const tree = await fs.walk("/docs")
```

## Search

```ts
// Full-text search (BM25)
const results = await fs.textSearch("machine learning", {
  path: "/docs",
  limit: 20,
})

// Semantic search (pgvector)
const similar = await fs.semanticSearch("how do LLMs work", {
  path: "/docs",
  limit: 10,
})

// Hybrid: BM25 + vector combined
const hybrid = await fs.hybridSearch("transformer architecture", {
  path: "/docs",
  textWeight: 0.4,
  vectorWeight: 0.6,
})
```

## Requirements

- PostgreSQL 15+ with the `ltree` extension
- Node.js 18+
- Optional: `pg_textsearch` for BM25 full-text search
- Optional: `pgvector` for semantic/hybrid search

## Subpath Exports

```
bash-gres            PgFileSystem, setup(), search, types
bash-gres/postgres   postgres.js adapter (setup, PgFileSystem, createPostgresClient)
bash-gres/drizzle    Drizzle adapter (setup, PgFileSystem, createDrizzleClient, createSchema)
```

## Development

```sh
docker compose up -d   # start postgres on localhost:5433
npm test               # run tests
npm run typecheck      # type check
npm run build          # compile to dist/
```

## Docs

Full documentation at [bashgres.com/docs](https://bashgres.com/docs).

## License

[MIT](LICENSE)
