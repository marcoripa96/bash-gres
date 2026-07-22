# bash-gres Setup Guide (for coding agents)

This guide tells you, the agent, how to set up **bash-gres** — a PostgreSQL-backed
virtual filesystem for AI agents — in a host project. `PgFileSystem` implements the
`just-bash` `IFileSystem` interface, so once installed you get a full sandboxed bash
environment (`new Bash({ fs })`) whose files live in Postgres, with workspace
isolation (RLS), copy-on-write versioning, and optional BM25/vector search.

Follow the steps in order. Do not skip Step 0.

---

## Step 0 — REQUIRED: ask the user before starting

Before writing any code or running any command, ask the user these questions and
wait for their answers. Do not guess from the codebase alone; confirm.

Use your environment's dedicated question tool to ask them — e.g.
`AskUserQuestion` in Claude Code, or whatever structured user-prompt mechanism
your harness provides — presenting the choices below as selectable options
rather than free-form chat text. Only fall back to a plain chat message if no
such tool is available.

1. **"Are you using Drizzle ORM or native bash-gres (a raw driver + `setup()`)?"**
   - **Drizzle** → follow **Path A**. bash-gres tables are folded into the
     project's Drizzle migrations and the runtime `setup()` is *never* called.
   - **Native** → follow **Path B**. Ask which driver: **postgres.js** or
     **node-postgres (pg)**. Schema is applied at runtime via the idempotent
     `setup()`.
2. **"Do you want full-text search (BM25 via `pg_textsearch`) and/or semantic
   search (pgvector)?"** — these change the schema options *and* the Postgres
   image (see Step 2). Default if unsure: both off.
3. **"What is the workspace model?"** — one workspace per tenant
   (e.g. `tenant:<tenantId>`, the datatalk pattern) or a single shared workspace
   (e.g. `"app"`, the reco-ai pattern).

Record the answers; several later steps branch on them.

---

## Step 1 — Install dependencies

```sh
npm install bash-gres just-bash

# plus exactly one driver stack:
npm install drizzle-orm postgres      # Path A (Drizzle over postgres.js)
npm install drizzle-orm pg           # Path A (Drizzle over node-postgres)
npm install postgres                  # Path B (postgres.js)
npm install pg                        # Path B (node-postgres)
```

Subpath exports — always import from the adapter matching the user's answer:

```
bash-gres                 core types (MountSpec, VersionDiffEntry, FsStat, ...)
bash-gres/drizzle         createDrizzleClient, createSchema, generateMigrationSQL, PgFileSystem
bash-gres/postgres        postgres.js adapter (setup, PgFileSystem, createPostgresClient)
bash-gres/node-postgres   pg adapter (setup, PgFileSystem, createNodePgClient)
```

---

## Step 2 — Postgres requirements

- **PostgreSQL 15+** (both reference projects run pg 18).
- **`ltree` extension** — always required. Available in stock images:
  `CREATE EXTENSION IF NOT EXISTS ltree;`
- **`pg_textsearch`** — only if BM25 full-text search was requested. It is NOT in
  stock images: it must be compiled into a custom image **and** added to
  `shared_preload_libraries` (it fails silently/at runtime otherwise).
- **`pgvector`** — only if semantic/hybrid search was requested. Use the
  `pgvector/pgvector` image or install the extension.

Custom image pattern (from datatalk `docker/db/pg18-pg_search/Dockerfile`) when
both search features are on:

```dockerfile
FROM pgvector/pgvector:pg18
# ... build & install pg_textsearch from github.com/timescale/pg_textsearch ...
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
```

If the user declined both search features, a stock `postgres` image is fine —
only `ltree` is needed (this is reco-ai's configuration).

Optionally add an initdb script for fresh dev containers
(`docker/postgres/initdb.d/01-extensions.sql`):

```sql
CREATE EXTENSION IF NOT EXISTS ltree;
```

The only required env var is the connection string, e.g.
`DATABASE_URL=postgresql://user:pass@localhost:5432/app`.

---

## Path A — Drizzle projects (datatalk & reco-ai pattern)

**Rule: never call bash-gres's runtime `setup()` in a Drizzle project.** It would
double-apply the same DDL out-of-band of drizzle-kit — a drift risk every time
bash-gres bumps its schema. Instead the schema flows through the project's normal
migration pipeline in two parts:

### A.1 — Expose the tables to drizzle-kit

Create a schema module that calls `createSchema()` and re-exports the five
tables, then include it in the drizzle-kit `schema` config:

```ts
// e.g. packages/database/src/schema/fs.ts
import { createSchema } from "bash-gres/drizzle"

// Options MUST match the user's Step-0 answers, and MUST stay identical
// to the generateMigrationSQL options in A.2.
const bashGres = createSchema({
  enableFullTextSearch: false,
  enableVectorSearch: false,
  // embeddingDimensions: 1536,   // only with enableVectorSearch: true
})

export const fsVersionRoots = bashGres.fsVersionRoots
export const fsVersions = bashGres.fsVersions
export const versionAncestors = bashGres.versionAncestors
export const fsBlobs = bashGres.fsBlobs
export const fsEntries = bashGres.fsEntries
```

Run `drizzle-kit generate` so the tables and indexes land in a normal migration.

### A.2 — Hand-commit the bootstrap SQL createSchema() cannot express

`createSchema()` cannot emit `CREATE EXTENSION` or RLS policies. Generate them
once with `generateMigrationSQL()` and paste the output into a committed SQL
migration (reco-ai: `drizzle/0002_bash_gres_rls.sql`; datatalk keeps a
regeneration script, `packages/database/scripts/generate-fs-bootstrap.ts`):

```ts
import { generateMigrationSQL } from "bash-gres/drizzle"

// Options MUST be identical to createSchema() in A.1.
console.log(generateMigrationSQL({
  enableRLS: true,
  enableFullTextSearch: false,
  enableVectorSearch: false,
}))
```

The output contains `CREATE EXTENSION IF NOT EXISTS ltree;` plus
`ENABLE/FORCE ROW LEVEL SECURITY` and a `workspace_isolation` policy keyed on
`current_setting('app.workspace_id', true)` for every `fs_*` table. Commit it as
a migration and note in a comment which options produced it, so it can be
regenerated when bash-gres is upgraded.

> `CREATE EXTENSION` and concurrent-index DDL may need to run outside a
> transaction depending on the project's migrator.

### A.3 — Construct the filesystem

```ts
import { drizzle } from "drizzle-orm/postgres-js"   // or drizzle-orm/node-postgres
import postgres from "postgres"
import { PgFileSystem } from "bash-gres/drizzle"

const client = postgres(process.env.DATABASE_URL!)
const db = drizzle(client, { casing: "snake_case" })

const fs = new PgFileSystem({ db, workspaceId: "tenant:acme" })
await fs.init()   // idempotent provisioning (INSERT ... ON CONFLICT DO NOTHING)
```

---

## Path B — Native (no ORM)

Here the runtime `setup()` IS the schema mechanism. It is idempotent
(`IF NOT EXISTS` everywhere) — call it once at startup.

**postgres.js:**

```ts
import postgres from "postgres"
import { setup, PgFileSystem } from "bash-gres/postgres"

const sql = postgres(process.env.DATABASE_URL!)
await setup(sql)   // extensions, tables, indexes, RLS

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })
await fs.init()
```

**node-postgres (pg):**

```ts
import pg from "pg"
import { setup, PgFileSystem } from "bash-gres/node-postgres"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! })
await setup(pool)

const fs = new PgFileSystem({ db: pool, workspaceId: "workspace-1" })
await fs.init()
```

`setup()` runs `CREATE EXTENSION`, which typically needs a privileged database
role. If the app role can't create extensions, pre-create them via initdb or a
one-off admin migration and let `setup()` handle the rest.

---

## Step 3 — Centralize construction in a wrapper module

Both reference projects converged on the same pattern: **do not scatter
`new PgFileSystem(...)` across the codebase.** Create one module (datatalk:
`packages/fs`; reco-ai: `openKnowledgeSnapshot()`) that owns:

- **workspaceId encoding** — one function, one source of truth for tenant
  isolation, e.g. `tenantWorkspaceId(id) => \`tenant:\${id}\``.
- **Named constructors** with permissions baked in, e.g.:
  - `openXxxFs()` — read-only: `permissions: { read: true, write: false }`
    (a misconfigured caller then gets `FsError(EPERM)` instead of silently writing)
  - `openXxxFsRW()` — read-write, calls `fs.init()` first
  - `initXxxFs()` — idempotent provisioning: `init()` + `mkdir` of the base tree;
    safe to call at the top of every job
  - `deleteXxxFs()` — teardown via `rm(path, { recursive: true, deleteVersionRoot: true })`
- **Policy options** set in one place: `historyRetention: "retain"` (keeps
  displaced versions addressable for history/diff UIs), `exclude` patterns,
  `versionRoot`, mounts.

Useful constructor options (see README for full API):

| Option | Purpose |
|---|---|
| `workspaceId` | RLS isolation boundary; required |
| `version` / `versionId` | movable label (default `"main"`) vs exact read-only snapshot; mutually exclusive |
| `versionRoot` + `rootDir` | scope the instance inside a versioned subdirectory |
| `permissions` | `{ read, write }`, enforced at the instance boundary |
| `historyRetention` | `"retain"` keeps deleted/displaced versions in history |
| `mount` | allow-list of visible subtrees, optional `readonly: true` per mount |
| `exclude` | gitignore-style hidden paths, propagated through forks |
| `maxWorkspaceBytes` | per-workspace blob quota → throws `FsQuotaError` (`ENOSPC`) |

---

## Step 4 — Wire into agent tools (just-bash)

```ts
import { Bash } from "just-bash"

const bash = new Bash({ fs, defenseInDepth: false })
const result = await bash.exec('echo "hi" > /notes.txt && cat /notes.txt')
// { exitCode: 0, stdout: "hi\n", stderr: "" }
```

**`defenseInDepth: false` is deliberate and load-bearing** (both projects do
this, with comments): the virtual FS has no network/python/shell-out surface, and
DiD's AsyncLocalStorage wrapping trips on unrelated concurrent Postgres activity
in the same async context. Copy this setting; rely on just-bash's
`maxOutputSize` for output truncation.

Typical LLM tool surface (Vercel AI SDK `tool()` pattern from both projects):

- `bash` — `{ script }` → `createBash({ fs }).exec(script)` → `{ stdout, stderr, exitCode }`
- `readFile` / `writeFile` / `editFile` — thin wrappers over `fs.*`; share a
  `readPaths: Set<string>` between them for a read-before-write guard.
- Inject `fs` per session/turn via tool **context** (AI SDK `experimental_context`
  / `contextSchema`) rather than binding at module scope — so tools stay
  stateless singletons and mutable version labels (e.g. `"active"`) resolve at
  call time, not at boot.

For a read-only assistant, scope its view with mounts instead of trusting prompt
instructions:

```ts
const fs = new PgFileSystem({
  db, workspaceId,
  mount: [
    { path: "/general", readonly: true },
    { path: `/clients/${clientId}`, readonly: true },
  ],
})
```

---

## Step 5 — Versioning idiom (fork → edit → promote)

The standard deploy flow used by both projects:

```ts
const draft = await liveFs.fork(`job-${jobId}`)   // O(1), copy-on-write
await draft.writeFile("/schema.md", updated)       // edit the draft
// review: await liveFs.diff(`job-${jobId}`)
await draft.promoteTo("active", { dropPrevious: true })  // atomic swap
// or discard: await liveFs.deleteVersion(`job-${jobId}`)
```

For per-entity version graphs inside one workspace, use versioned directories:
`await fs.mkdir("/databases/<id>", { versioned: true })`, then operate through
`await fs.versioned("/databases/<id>")`. Versioned directories cannot be nested.

---

## Step 6 — Verify

1. Migrations applied (Path A) or `setup()` ran without error (Path B).
2. Smoke test (adapt datatalk's `packages/fs/src/scripts/smoke-test.ts`):
   ```ts
   const fs = new PgFileSystem({ db, workspaceId: "smoke-test" })
   await fs.init()
   await fs.writeFile("/hello.txt", "hello")
   const bash = new Bash({ fs, defenseInDepth: false })
   console.log(await bash.exec("cat /hello.txt"))   // stdout: "hello"
   ```
3. If search is enabled: `await fs.textSearch("hello")` returns without a
   missing-extension error (if it errors, check `shared_preload_libraries`).
4. RLS sanity: constructing a second `PgFileSystem` with a different
   `workspaceId` must not see the first workspace's files.

---

## Gotchas checklist

- **Never mix Path A and Path B.** In a Drizzle project, calling `setup()`
  double-applies DDL and drifts from the migration history.
- **`createSchema()` and `generateMigrationSQL()` options must be identical**,
  and must be regenerated together on bash-gres upgrades.
- **RLS depends on the adapter.** Policies key on
  `current_setting('app.workspace_id', true)`; the bash-gres adapters set that
  GUC via `SET LOCAL` in every transaction. If you query `fs_*` tables directly
  with your own client, you'll get **zero rows** unless you set the GUC (or use
  a role that bypasses RLS).
- **`fs.init()` is required before first use** of a workspace and is idempotent —
  call it defensively at the start of jobs. **Mounted/scoped instances cannot be
  `init()`-ed** (they can't write `/`); init with an unscoped instance first.
- **`pg_textsearch` must be in `shared_preload_libraries`** — installing the
  extension alone is not enough.
- **`defenseInDepth: false`** on `Bash` — see Step 4; leaving it on causes
  failures under concurrent pg activity.
- **`rm` on a versioned directory only hides it.** Permanent deletion of the
  version root + history requires `{ recursive: true, deleteVersionRoot: true }`.
- **Version labels are movable; `versionId` is stable.** Pin conversations or
  snapshots to a numeric `versionId` from `listHistory()`, and use
  `historyRetention: "retain"` if displaced versions must stay addressable.

## Reference implementations

- **datatalk** — Drizzle over node-postgres; per-tenant workspaces
  (`tenant:<id>`), versioned directories per database, fork/promote lifecycle.
  See `packages/fs/`, `packages/database/src/schema.ts`,
  `packages/database/scripts/generate-fs-bootstrap.ts`, `packages/ai/src/fs-tools/`.
- **reco-ai** — Drizzle over postgres.js; single `"app"` workspace, read-only
  mounted snapshots for chat/voice agents. See `packages/database/src/schema/fs.ts`,
  `packages/database/drizzle/0002_bash_gres_rls.sql`,
  `packages/ai/src/knowledge-snapshot.ts`, `packages/ai/src/tools/bash.ts`.
- **Upstream docs** — `README.md` in this repo and [bashgres.com/docs](https://bashgres.com/docs).
