# bash-gres

PostgreSQL-backed virtual filesystem for AI agents. Implements the [just-bash](https://github.com/vercel-labs/just-bash) `IFileSystem` interface, so you can pass it directly to `new Bash({ fs })` and get a complete bash environment backed by PostgreSQL.

## Features

- Full bash environment via [just-bash](https://github.com/vercel-labs/just-bash): 60+ commands, pipes, redirects, variables, loops
- Node.js `fs`-compatible API: readFile, writeFile, mkdir, cp, mv, rm, symlink, stat, walk, glob
- Workspace isolation via PostgreSQL Row-Level Security
- Named versions per workspace: fork, list, delete -- isolated working copies and deploy snapshots
- BM25 full-text search via `pg_textsearch`
- Optional pgvector semantic and hybrid search
- Bring your own driver: `postgres.js`, `node-postgres (pg)`, or Drizzle ORM

## Install

```sh
npm install bash-gres
```

Then install your database driver and just-bash:

```sh
# postgres.js
npm install postgres just-bash

# node-postgres (pg)
npm install pg just-bash

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

### With node-postgres (pg)

```ts
import pg from "pg"
import { Bash } from "just-bash"
import { setup, PgFileSystem } from "bash-gres/node-postgres"

const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/myapp" })
await setup(pool)

const fs = new PgFileSystem({ db: pool, workspaceId: "workspace-1" })
const bash = new Bash({ fs })
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

// Slice large files server-side
const bytes = await fs.readFileRange("/log.txt", { offset: 0, limit: 1024 })
const { content: head, total } = await fs.readFileLines("/log.txt", { offset: 1, limit: 50 })

await fs.cp("/docs", "/backup", { recursive: true })
await fs.mv("/backup/guide.md", "/archive/guide.md")
await fs.rm("/archive", { recursive: true, force: true })

await fs.symlink("/docs/guide.md", "/latest")
const stat = await fs.stat("/docs/guide.md")
const tree = await fs.walk("/docs")
```

## Versioning

Each `PgFileSystem` instance is bound to a `version` (default `"main"`). Versions within a workspace are fully isolated, so the same path can hold different contents. Fork is O(1): it links the new version to its parent through a closure table without copying any entry rows. Reads walk that closure to the nearest ancestor that has a row at the requested path.

This is a **live ancestor overlay**, not a historical snapshot. A write to a parent version after a child has been forked can still affect the child's visible view at any path the child has not shadowed. Once the child writes (or deletes) a path, that path is shielded from later parent writes. To freeze a checkpoint independent of its parents, fork and then `detach()`.

```ts
const v1 = new PgFileSystem({ db: sql, workspaceId: "app", version: "v1" })
await v1.writeFile("/config.json", '{"env":"staging"}')

const v2 = await v1.fork("v2")                 // O(1) link, no row copy
await v2.writeFile("/config.json", '{"env":"prod"}')

await v1.readFile("/config.json") // '{"env":"staging"}' (untouched)
await v2.readFile("/config.json") // '{"env":"prod"}'

await v1.listVersions()     // ["v1", "v2"]
await v1.deleteVersion("v2") // drops every row in v2
```

The "live" version is caller-side: BashGres exposes versions as data, your app decides which one the runtime reads from. See [bashgres.com/docs/versioning](https://bashgres.com/docs/versioning) for the deploy pattern.

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
bash-gres                PgFileSystem, setup(), search, types
bash-gres/postgres       postgres.js adapter (setup, PgFileSystem, createPostgresClient)
bash-gres/node-postgres  node-postgres (pg) adapter (setup, PgFileSystem, createNodePgClient)
bash-gres/drizzle        Drizzle adapter (setup, PgFileSystem, createDrizzleClient, createSchema)
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
