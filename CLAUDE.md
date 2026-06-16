# bash-gres

PostgreSQL-backed virtual filesystem for AI agents. `PgFileSystem` implements the `just-bash` `IFileSystem` interface, so it can be passed directly to `new Bash({ fs })`.

## Architecture

```
bash-gres (core)          PgFileSystem, setup(), search, types
bash-gres/drizzle         Drizzle adapter (createDrizzleClient) + schema
bash-gres/node-postgres   node-postgres (pg) adapter (createNodePgClient)
bash-gres/postgres        postgres.js adapter (createPostgresClient)
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

- `lib/core/types.ts`: `SqlClient`, `FsError`, `SqlError`, all option/result interfaces
- `lib/core/filesystem.ts`: `PgFileSystem` class with all fs operations (implements `IFileSystem`)
- `lib/core/filesystem/ops/`: per-op implementations installed onto `PgFileSystem.prototype` (one file per op, e.g. `list-history.ts`, `version-diff.ts`, `merge.ts`); shared SQL helpers live next to them (`fetch-diff.ts`, `fetch-page-changes.ts`, `fetch-version-changes.ts`)
- `lib/core/setup.ts`: idempotent DDL: extensions, table, indexes, RLS, optional pgvector
- `lib/core/path-encoding.ts`: path <-> ltree conversion using `_xHEX_` delimited encoding
- `lib/core/search.ts`: BM25 full-text search via pg_textsearch, optional pgvector semantic/hybrid
- `lib/core/mounts.ts`: `mount` allow-list (default-deny scoping to subtrees of one workspace). Sibling to `exclude.ts`: `compileMounts` + `mountVisible`/`mountWritable` (JS guards) + `mountWhereSql` (the `path <@ ANY OR path @> ANY` clause threaded into every listing/walk/glob/search query via `buildMountClause`)
- `lib/adapters/drizzle/adapter.ts`: converts Drizzle `db` into `SqlClient` (`DrizzleDb` interface, `createDrizzleClient`)
- `lib/adapters/drizzle/schema.ts`: Drizzle `pgTable` with all indexes (GiST, BM25, partial)
- `lib/adapters/node-postgres/index.ts`: wraps `pg.Pool` into `SqlClient` (structural `NodePgPool` interface)
- `lib/adapters/postgres/index.ts`: wraps `postgres.Sql` into `SqlClient`

### Git-like history APIs

- `listHistory({ limit?, cursor?, includeChanges?, includeRoot?, path? })`: paginated ancestor walk from current version backwards. `includeChanges`: `false` (default, metadata only), `"paths"` (cheap `{ path, change }` summary), `true` (full `VersionDiffEntry` with before/after shapes). All three modes hit a single batched query (`fetch-page-changes.ts`) — paths and full are nearly the same cost.
- `versionDiff(versionId, { path? })`: full diff for a single history entry, by numeric `versionId` from `listHistory`. Bypasses the label resolver, so it works for deleted-but-retained entries and for root entries (parent NULL → diff vs empty tree). Uses the COW shortcut (`WHERE version_id = V` for the "after" side, scoped parent-visibility for the "before") so it skips the full-tree FULL OUTER JOIN that label-based `diff(other)` runs.
- `versionDiffStream(versionId, { path?, batchSize? })`: streaming variant with keyset pagination by ltree path.
- `sweepHistory()`: physically flatten retained history. Materializes inherited entries into each active version in one batched `INSERT ... SELECT` over `version_ancestors` (`ROW_NUMBER() PARTITION BY descendant_id, path ORDER BY depth`), nulls active parents, deletes inactive rows + closure rows + orphan blobs. Run on a `historyRetention: "retain"` workspace to compact it.

## Database

- **Tables**: `fs_version_roots`, `fs_versions`, `version_ancestors`, `fs_entries`, `fs_blobs`
- **Extensions**: `ltree`, `pg_textsearch` (v1.0.0), optionally `pgvector`
- **Indexes**: GiST on ltree paths, version-root label uniqueness, ancestor closure depth/reverse indexes, blob hash, optional BM25/HNSW
- **RLS**: policy on `workspace_id = current_setting('app.workspace_id', true)`, set via `SET LOCAL` in every transaction
- **Workspace ID**: text (UUID by default), scoped per `PgFileSystem` instance
- **Version root**: `/` by default; `mkdir(path, { versioned: true })` creates a non-nested directory-level version root opened via `fs.versioned(path)`
- **Mounts**: `new PgFileSystem({ mount: [{ path: "/users/u1" }, { path: "/general", readonly: true }, ...] })` restricts one instance to an allow-list of subtrees of a single workspace (one version graph), with identity paths — no remapping. Only paths inside a mount, plus the ancestor dirs leading to them, are visible (`ls /` shows just those branches); everything else is `ENOENT`. Writes are allowed only inside a non-readonly mount. This replaces the removed `MountFs` router for the single-workspace, scoped-per-view case; a router is only needed for cross-workspace/cross-DB unions.

## Commands

```sh
npm run build        # tsc -> dist/
npm run test         # vitest (set TEST_DATABASE_URL for compose postgres on localhost:5434)
npm run typecheck    # tsc --noEmit
```

### Running tests

Tests require PostgreSQL with ltree extension on `localhost:5434`:

```sh
docker compose up -d
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/bashgres_test npm test
```

Test DB: `bashgres_test`. Tests use `fileParallelism: false` and shared setup via `tests/global-setup.ts`.

## Code conventions

- ESM-only, TypeScript strict mode
- No `any`; use structural interfaces and type guards at adapter boundaries
- `as` casts only at driver boundaries (e.g., `result as T[]` when bridging between type systems)
- Peer deps: `drizzle-orm`, `postgres`, `pg`, and `just-bash` are all optional
- Path encoding: special chars become `_xHEX_` (delimited to prevent greedy regex issues)
- All filesystem operations run inside explicit transactions with `SET LOCAL app.workspace_id` and `SET LOCAL statement_timeout`
- `setup()` is idempotent (safe to call on every startup); uses `IF NOT EXISTS` / `IF NOT EXISTS` everywhere
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
