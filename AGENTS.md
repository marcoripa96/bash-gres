# bash-gres

PostgreSQL-backed virtual filesystem with bash command interface for AI agents.

## Architecture

```
bash-gres (core)          — PgFileSystem, setup(), search, types
bash-gres/bash            — BashInterpreter (ls, cat, echo, mkdir, rm, etc.)
bash-gres/drizzle         — Drizzle schema (fsNodes) + auto-detection bridge
bash-gres/postgres        — postgres.js adapter (createPostgresClient)
```

### Core + Adapter pattern

The core operates on a `SqlClient` interface (`query(text, params)` + `transaction(fn)`). Two ways to provide it:

- **Drizzle**: pass `db` directly to `PgFileSystem({ db })` — auto-detected and wrapped via lazy `import("drizzle-orm")`
- **postgres.js**: wrap with `createPostgresClient(sql)` then pass as `db`

The Drizzle bridge lives in `src/core/drizzle-bridge.ts`. It converts `$1, $2` positional params into Drizzle's `sql` tagged template via `_x$N_` splitting. The `drizzle-orm` import is lazy-cached so postgres.js-only users never load it.

### Key modules

- `src/core/types.ts` — `SqlClient`, `DrizzleDb`, `FsError`, `SqlError`, all option/result interfaces
- `src/core/filesystem.ts` — `PgFileSystem` class with all fs operations
- `src/core/setup.ts` — idempotent DDL: extensions, table, indexes, RLS, optional pgvector
- `src/core/path-encoding.ts` — path <-> ltree conversion using `_xHEX_` delimited encoding
- `src/core/search.ts` — BM25 full-text search via pg_textsearch, optional pgvector semantic/hybrid
- `src/core/bash/interpreter.ts` — `BashInterpreter` class, orchestration (pipes, redirects, globs)
- `src/core/bash/types.ts` — `Command` interface, `CommandContext`, `ok`/`err` helpers
- `src/core/bash/parsing.ts` — tokenizer, command parser, pipe/operator splitting
- `src/core/bash/helpers.ts` — `matchGlob`, `formatLong` shared utilities
- `src/core/bash/commands/<name>/<name>.ts` — one file per command, each exports a `Command`
- `src/core/bash/commands/<name>/<name>.test.ts` — co-located tests for each command
- `src/adapters/drizzle/schema.ts` — Drizzle `pgTable` with all indexes (GiST, BM25, partial)
- `src/adapters/postgres/index.ts` — wraps `postgres.Sql` into `SqlClient`

## Database

- **Table**: single `fs_nodes` table with ltree paths, session isolation, self-referencing parent_id (ON DELETE RESTRICT)
- **Extensions**: `ltree`, `pg_textsearch` (v1.0.0), optionally `pgvector`
- **Indexes**: GiST on ltree, BM25 on (name, content), partial index for directories, covering index for stat
- **RLS**: policy on `session_id = current_setting('app.session_id', true)`, set via `SET LOCAL` in every transaction
- **Session ID**: text (UUID by default), scoped per `PgFileSystem` instance

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
- All filesystem operations run inside explicit transactions with `SET LOCAL app.session_id` and `SET LOCAL statement_timeout`
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
