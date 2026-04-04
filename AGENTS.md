# bash-gres

PostgreSQL-backed virtual filesystem with bash command interface for AI agents.

## Architecture

```
bash-gres (core)          — PgFileSystem, setup(), search, types
bash-gres/bash            — BashInterpreter (ls, cat, echo, mkdir, rm, etc.)
bash-gres/drizzle         — Drizzle adapter (createDrizzleClient) + schema
bash-gres/postgres        — postgres.js adapter (createPostgresClient)
```

### Core + Adapter pattern

The core operates on a `SqlClient` interface (`query(text, params)` + `transaction(fn)`). Adapters wrap driver-specific connections into `SqlClient`:

- **postgres.js**: `createPostgresClient(sql)` from `bash-gres/postgres`
- **Drizzle**: `createDrizzleClient(db)` from `bash-gres/drizzle`

Then pass the resulting `SqlClient` to `PgFileSystem({ db: client })` and `setup(client)`. Core has zero knowledge of any specific driver.

The Drizzle adapter (`lib/adapters/drizzle/adapter.ts`) converts `$1, $2` positional params into Drizzle's `sql` tagged template.

### Key modules

- `lib/core/types.ts` — `SqlClient`, `FsError`, `SqlError`, all option/result interfaces
- `lib/core/filesystem.ts` — `PgFileSystem` class with all fs operations
- `lib/core/setup.ts` — idempotent DDL: extensions, table, indexes, RLS, optional pgvector
- `lib/core/path-encoding.ts` — path <-> ltree conversion using `_xHEX_` delimited encoding
- `lib/core/search.ts` — BM25 full-text search via pg_textsearch, optional pgvector semantic/hybrid
- `lib/core/bash/interpreter.ts` — `BashInterpreter` class, orchestration (pipes, redirects, globs)
- `lib/core/bash/types.ts` — `Command` interface, `CommandContext`, `ok`/`err` helpers
- `lib/core/bash/parsing.ts` — tokenizer, command parser, pipe/operator splitting
- `lib/core/bash/helpers.ts` — `matchGlob`, `formatLong` shared utilities
- `lib/core/bash/commands/<name>/<name>.ts` — one file per command, each exports a `Command`
- `lib/core/bash/commands/<name>/<name>.test.ts` — co-located tests for each command
- `lib/adapters/drizzle/adapter.ts` — converts Drizzle `db` into `SqlClient` (`DrizzleDb` interface, `createDrizzleClient`)
- `lib/adapters/drizzle/schema.ts` — Drizzle `pgTable` with all indexes (GiST, BM25, partial)
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
- Peer deps: `drizzle-orm` and `postgres` are both optional
- Path encoding: special chars become `_xHEX_` (delimited to prevent greedy regex issues)
- All filesystem operations run inside explicit transactions with `SET LOCAL app.workspace_id` and `SET LOCAL statement_timeout`
- `setup()` is idempotent (safe to call on every startup) — uses `IF NOT EXISTS` / `IF NOT EXISTS` everywhere
- Prefer named files over `index.ts` (e.g., `interpreter.ts`, `cat.ts`); avoid barrel/re-export files unless strictly necessary

## Subpath exports

```json
{
  ".":          "dist/core/index.js",
  "./drizzle":  "dist/adapters/drizzle/index.js",
  "./postgres": "dist/adapters/postgres/index.js",
  "./bash":     "dist/core/bash/interpreter.js"
}
```
