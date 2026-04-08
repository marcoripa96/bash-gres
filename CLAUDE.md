# bash-gres

PostgreSQL-backed virtual filesystem for AI agents. `PgFileSystem` implements the `just-bash` `IFileSystem` interface, so it can be passed directly to `new Bash({ fs })`.

## Architecture

```
bash-gres (core)          — PgFileSystem, setup(), search, types
bash-gres/drizzle         — Drizzle adapter (createDrizzleClient) + schema
bash-gres/node-postgres   — node-postgres (pg) adapter (createNodePgClient)
bash-gres/postgres        — postgres.js adapter (createPostgresClient)
```

### Core + Adapter pattern

The core operates on a `SqlClient` interface (`query(text, params)` + `transaction(fn)`). Adapters wrap driver-specific connections into `SqlClient`:

- **postgres.js**: `createPostgresClient(sql)` from `bash-gres/postgres`
- **node-postgres (pg)**: `createNodePgClient(pool)` from `bash-gres/node-postgres`
- **Drizzle**: `createDrizzleClient(db)` from `bash-gres/drizzle`

Then pass the resulting `SqlClient` to `PgFileSystem({ db: client })` and `setup(client)`. Core has zero knowledge of any specific driver.

The Drizzle adapter (`lib/adapters/drizzle/adapter.ts`) converts `$1, $2` positional params into Drizzle's `sql` tagged template.

### Bash integration

`PgFileSystem` structurally implements the `just-bash` `IFileSystem` interface. Users pass it directly:

```ts
import { Bash } from "just-bash";
const bash = new Bash({ fs: pgFs });
await bash.exec("echo hello > /file.txt");
```

### Key modules

- `lib/core/types.ts` — `SqlClient`, `FsError`, `SqlError`, all option/result interfaces
- `lib/core/filesystem.ts` — `PgFileSystem` class with all fs operations (implements `IFileSystem`)
- `lib/core/setup.ts` — idempotent DDL: extensions, table, indexes, RLS, optional pgvector
- `lib/core/path-encoding.ts` — path <-> ltree conversion using `_xHEX_` delimited encoding
- `lib/core/search.ts` — BM25 full-text search via pg_textsearch, optional pgvector semantic/hybrid
- `lib/adapters/drizzle/adapter.ts` — converts Drizzle `db` into `SqlClient` (`DrizzleDb` interface, `createDrizzleClient`)
- `lib/adapters/drizzle/schema.ts` — Drizzle `pgTable` with all indexes (GiST, BM25, partial)
- `lib/adapters/node-postgres/index.ts` — wraps `pg.Pool` into `SqlClient` (structural `NodePgPool` interface)
- `lib/adapters/postgres/index.ts` — wraps `postgres.Sql` into `SqlClient`

## Database

- **Table**: single `fs_nodes` table with ltree paths, workspace isolation, self-referencing parent_id (ON DELETE RESTRICT)
- **Extensions**: `ltree`, `pg_textsearch` (v1.0.0), optionally `pgvector`
- **Indexes**: GiST on ltree, BM25 on (name, content), partial index for directories, covering index for stat
- **RLS**: policy on `workspace_id = current_setting('app.workspace_id', true)`, set via `SET LOCAL` in every transaction
- **Workspace ID**: text (UUID by default), scoped per `PgFileSystem` instance

## Commands

```sh
npm run build        # tsc -> dist/
npm run test         # vitest (requires postgres on localhost:5433)
npm run typecheck    # tsc --noEmit
```

### Running tests

Tests require PostgreSQL with ltree extension on `localhost:5433`:

```sh
docker compose up -d
npm test
```

Test DB: `bashgres_test`. Tests use `fileParallelism: false` and shared setup via `tests/global-setup.ts`.

## Code conventions

- ESM-only, TypeScript strict mode
- No `any` — use structural interfaces and type guards at adapter boundaries
- `as` casts only at driver boundaries (e.g., `result as T[]` when bridging between type systems)
- Peer deps: `drizzle-orm`, `postgres`, `pg`, and `just-bash` are all optional
- Path encoding: special chars become `_xHEX_` (delimited to prevent greedy regex issues)
- All filesystem operations run inside explicit transactions with `SET LOCAL app.workspace_id` and `SET LOCAL statement_timeout`
- `setup()` is idempotent (safe to call on every startup) — uses `IF NOT EXISTS` / `IF NOT EXISTS` everywhere
- Prefer named files over `index.ts` (e.g., `filesystem.ts`, `setup.ts`); avoid barrel/re-export files unless strictly necessary

## Subpath exports

```json
{
  ".":               "dist/core/index.js",
  "./drizzle":       "dist/adapters/drizzle/index.js",
  "./node-postgres": "dist/adapters/node-postgres/index.js",
  "./postgres":      "dist/adapters/postgres/index.js"
}
```
