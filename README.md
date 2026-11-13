# bash-gres

PostgreSQL-backed virtual filesystem for AI agents. Implements the [just-bash](https://github.com/vercel-labs/just-bash) `IFileSystem` interface, so you can pass it directly to `new Bash({ fs })` and get a complete bash environment backed by PostgreSQL.

## Features

- Full bash environment via [just-bash](https://github.com/vercel-labs/just-bash): 60+ commands, pipes, redirects, variables, loops
- Node.js `fs`-compatible API: readFile, writeFile, mkdir, cp, mv, rm, symlink, stat, walk, glob
- Workspace isolation via PostgreSQL Row-Level Security
- Copy-on-write versions per version root: fork, diff, merge, revert, promote, delete
- Versioned directories via `mkdir(path, { versioned: true })` and scoped facades
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

## Workspace Usage

```ts
const usage = await fs.getUsage()
const projectUsage = await fs.getUsage({ path: "/project" })

usage.logicalBytes     // visible file + symlink bytes in fs.version
usage.referencedBlobBytes // deduplicated blob bytes referenced by visible files
usage.storedBlobBytes  // deduplicated blob bytes stored for the workspace
usage.blobCount        // stored blob rows
usage.versions         // version labels in the active version root
usage.entryRows        // fs_entries rows in the active version root, including tombstones
usage.visibleNodes     // visible nodes in fs.version, including root
usage.limits           // { maxFiles, maxFileSize, maxWorkspaceBytes? }
```

Set `maxWorkspaceBytes` to enforce a deduplicated blob-storage quota per workspace:

```ts
const fs = new PgFileSystem({
  db: sql,
  workspaceId: "tenant-a",
  maxWorkspaceBytes: 100 * 1024 * 1024,
})

try {
  await fs.writeFile("/large.bin", bytes)
} catch (e) {
  if (e instanceof FsQuotaError) {
    e.code            // "ENOSPC"
    e.limit           // configured maxWorkspaceBytes
    e.current         // current stored blob bytes
    e.attemptedDelta  // bytes for the new unique blob
  }
}
```

## Versioning

Each `PgFileSystem` instance is bound to a `version` (default `"main"`) inside an active **version root**. By default the version root is `/`, preserving workspace-wide versioning. You can also make any non-nested directory versionable and work through a scoped facade rooted at that directory.

Versions are copy-on-write overlays: the same path can hold different contents, and `fork()` is O(1) because it links the new version to its parent through a closure table without copying entry rows. Reads walk that closure to the nearest ancestor with a row at the requested path.

This is a **live ancestor overlay**, not a historical snapshot. A write to a parent version after a child has been forked can still affect the child's visible view at any path the child has not shadowed. Once the child writes (or deletes) a path, that path is shielded from later parent writes. To make a version immutable, `freeze()` it: every later content write to it fails with `EPERM`, from any handle, so its forks and the merges based on it stay stable. To stop a version reading through its ancestors, `materialize()` it (history kept) or `detach()` it (history cut).

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

### Versioned Directories

Use `mkdir(path, { versioned: true })` to make a directory an independent version root, similar to running `git init` inside that directory. The directory remains a normal filesystem directory, but version operations on its scoped facade only affect that subtree.

```ts
const fs = new PgFileSystem({ db: sql, workspaceId: "app" })
await fs.init()

await fs.mkdir("/database", { versioned: true })

const dbMain = await fs.versioned("/database")
await dbMain.writeFile("/schema.sql", "main")

const dbDraft = await dbMain.fork("draft")
await dbDraft.writeFile("/schema.sql", "draft")

await dbMain.readFile("/schema.sql")  // "main"
await dbDraft.readFile("/schema.sql") // "draft"
await dbMain.listVersions()           // ["draft", "main"]
```

Version labels are scoped to the versioned directory, so `/database` and `/user` can both have a `draft` version. Nested versioned directories are rejected.

Removing a versioned directory with `rm(path, { recursive: true })` only hides the mount point from the parent filesystem. To permanently delete the version root and all versions/history stored under it, opt in explicitly:

```ts
await fs.rm("/database", { recursive: true, deleteVersionRoot: true })
```

Versioning primitives include:

- `diff(other, { path? })`, `diffCount(other, { path?, nodeType? })`, and `diffStream(other, { path?, batchSize? })` to compare visible trees.
- `merge(source, { strategy?, paths?, pathScope?, dryRun?, resolve?, includeContent? })` for LCA-based three-way merges. `resolve` settles conflicting files from their base/ours/theirs text (`textMergeResolver` is a ready line-based merge with git's rules); see [Merge resolvers](#merge-resolvers-and-text-diffs).
- `cherryPick(source, paths)` to source-win copy selected paths without LCA conflict checks.
- `revert(target, { paths?, pathScope? })` to restore selected paths to another version.
- `detach()` to materialize a version into a standalone snapshot independent of ancestors (cuts its history).
- `freeze()` to make the current version refuse all further content writes; `materialize()` to stop it reading through its ancestors while keeping its history; `compactHistory()` to do that for every frozen or retained version of the root at once.
- `renameVersion(label, { swap? })` and `promoteTo(label, { dropPrevious?, freeze?, materialize? })` for deploy labels.
- `listHistory({ limit?, cursor?, includeChanges?, includeRoot?, path? })` to walk ancestor history with keyset pagination, plus `versionDiff(versionId, { path? })` and `versionDiffStream(versionId, { path?, batchSize? })` to fetch the diff for a single history entry.
- `diffVersions(from, to, { path?, includeContent?, unifiedDiff? })` to compare any two versions of the root by numeric `versionId` — both sides bypass the label resolver, so deleted-but-retained versions compare fine.
- `sweepHistory()` to physically flatten retained history into self-contained snapshots and GC orphan blobs.

The "live" version is caller-side: BashGres exposes versions as data, your app decides which one the runtime reads from. A typical deploy flow is `fork()` a draft, edit it, optionally `merge()` or `revert()` changes, then `promoteTo("live")`. See [bashgres.com/docs/versioning](https://bashgres.com/docs/versioning) for the full versioning guide.

### Opening an exact historical version

Labels such as `main` are movable references. For a stable snapshot, take the
numeric `versionId` returned by `listHistory()` and open it directly. Exact
versions are read-only and remain available after their labels are deleted when
history retention is enabled.

```ts
const [{ versionId }] = (await fs.listHistory({ limit: 1 })).entries

const snapshot = new PgFileSystem({
  db: sql,
  workspaceId: "app",
  versionId,
  permissions: { read: true, write: false },
})

await snapshot.readFile("/config.json")
```

`version` and `versionId` are mutually exclusive. An ID is also checked against
the requested workspace and version root before any content is read.

For a versioned directory, pass the id to `versioned()`; the handle is read-only:

```ts
const pinned = await fs.versioned("/artifacts/a1", { versionId })
```

### Publishing: freeze and materialize

With retained history, a chain of publishes stays cheap and fully browsable
when each publish is frozen and materialized:

```ts
const fs = new PgFileSystem({ db: sql, workspaceId: "app", historyRetention: "retain" })
const chat = await (await fs.versioned("/artifacts/a1")).fork("chat-42")
// ... edits ...
await chat.transaction(async (tx) => {
  const r = await tx.merge("main", { resolve: textMergeResolver }) // main may have moved
  if (r.conflicts.length > 0) throw new Error("conflicts")
  await tx.promoteTo("main", { dropPrevious: true, freeze: true, materialize: true })
})
```

- `freeze` stops every further write to the published version, including
  writes through a handle that cached its id before the label moved.
- `materialize` copies the inherited entries into the version and drops its
  ancestor-closure rows, keeping `parent_version_id`. Each published version
  costs one closure row and one entry row per file, so the chain grows
  linearly, while `listHistory`, `versionDiff`, `diffVersions` and
  `versioned(path, { versionId })` keep working across all of it.
- A full `merge()` of a frozen source records it as a merge parent
  (`mergedFrom` in `listHistory()`); merge bases follow parent links and
  merge parents, so a fork that already merged main is not re-conflicted
  against an older ancestor. As with a git merge commit, conflicts settled
  by `strategy: "ours" | "theirs"` count as merged.
- `compactHistory()` applies the same trimming to roots built before 3.2,
  removing nothing. It materializes a version only when it and every
  ancestor it reads through are frozen or deleted, so a live, unfrozen
  version's writes keep showing through in its forks.

### Merge resolvers and text diffs

`merge()` compares whole files against the common ancestor. A `resolve`
callback gets each conflicting file's text at the base and on both sides
(modify/modify, add/add, modify/delete; directory and symlink conflicts are
not offered) and returns `{ content }`, `{ remove: true }`, or `undefined` to
leave the conflict to `strategy`. It runs in path order inside the merge
transaction, also under `dryRun`; settled paths are listed in `resolved`.
The merge locks the destination first, so a concurrent write to it waits
for the merge to commit, and the merge is never computed from a stale view
of the destination. A write already in flight when the merge commits applies
what it read before waiting, as between any two concurrent writes.

Line diffs are exact for ordinary edits (up to about 2,000 changed lines per
file); past that budget the remaining differing range is treated as wholly
replaced, so time and memory stay bounded on very different large files.

```ts
import { mergeText, textMergeResolver, createUnifiedDiff } from "bash-gres"

await chat.merge("main", {
  resolve: (c) => (c.path.endsWith(".md") ? myDocMerge(c) : textMergeResolver(c)),
})

mergeText(base, ours, theirs)   // { clean: true, content } | { clean: false, content /* <<<<<<< markers */, conflicts }
createUnifiedDiff(before, after, { path: "/q.sql" })  // git-style patch
```

Diff APIs (`diff`, `diffStream`, `diffVersions`, `versionDiff`,
`versionDiffStream`) take `unifiedDiff: true | { context }` and return a
patch per changed text file in `unifiedDiff` (`null` for binary files,
directories, symlinks and mode-only changes).

### Browsing history

`listHistory()` returns ancestor versions (following `parent_version_id`) paginated from the current version backwards; entries carry `frozenAt` and `mergedFrom`. `includeChanges` controls how much per-entry detail comes back: `false` (default, just metadata), `"paths"` (cheap path + change-kind summary), or `true` (full `before`/`after` shapes). All three modes share a single batched query, so paths-mode and full-changes mode are within ~5% of each other on large pages.

```ts
const fs = new PgFileSystem({
  db: sql,
  workspaceId: "app",
  version: "main",
  historyRetention: "retain",   // keep deleted versions in history
})

// 1. List page metadata + per-row "what changed" summary.
const page = await fs.listHistory({ limit: 20, includeChanges: "paths" })
for (const entry of page.entries) {
  console.log(entry.version, entry.createdAt, entry.changes.length, "changes")
  // entry.changes: [{ path, change: "added"|"removed"|"modified"|"type-changed" }]
}
if (page.nextCursor) { /* fetch next page with { cursor: page.nextCursor } */ }

// 2. Click an entry → full diff against its parent (works for root and
//    deleted-but-retained entries too).
const detail = await fs.versionDiff(page.entries[0]!.versionId)
// detail: VersionDiffEntry[] with full before/after shapes

// 3. Or stream large diffs page-by-page.
for await (const change of fs.versionDiffStream(page.entries[0]!.versionId, { batchSize: 100 })) {
  // ...
}

// 4. Compare any two versions directly (not just parent/child).
const between = await fs.diffVersions(
  page.entries[3]!.versionId,
  page.entries[0]!.versionId,
  { includeContent: true },
)
```

`historyRetention: "retain"` keeps deleted version rows visible in history (with `deletedAt !== null`); the default `"discard"` physically removes them. Run `sweepHistory()` to compact a retain-mode workspace back into self-contained snapshots and GC blobs no live entry references.

## Search

All search is **chunk-granular**: text files are indexed as markdown-aware
**section chunks** (table `fs_blob_chunks`) — heading-bounded slices with
1-indexed line ranges, a heading breadcrumb ("Title > Section"), and a token
budget that fits embedding models. Hits are ranked sections, each addressable
as `path:startLine-endLine` and hydratable via `readFileLines()`. Chunks are
keyed by the blob hash, so unchanged content is never re-chunked — across
rewrites, copies, versions, and branches. At most `perFileCap` hits per file
(default 3) keep one long page from monopolizing the top-k.

**Enable** chunking per instance; it is off by default and existing databases
are unaffected until you do:

```ts
const fs = new PgFileSystem({ db, workspaceId, chunking: true })
// or tune: chunking: { maxTokens: 480, estimateTokens: (s) => ... }

await fs.writeFile("/docs/page.md", markdown) // chunks stored with the write
const chunks = await fs.readFileChunks("/docs/page.md")
// [{ chunkIndex, startLine, endLine, headingPath, content }, ...]
```

**Text search** with BM25 (needs the full-text-search setup —
`enableFullTextSearch`, the default):

```ts
const hits = await fs.textSearch("shipping costs", { path: "/docs", limit: 10 })
// [{ path, startLine, endLine, headingPath, content, rank }, ...]
const { content } = await fs.readFileLines(hits[0].path, {
  offset: hits[0].startLine,
  limit: hits[0].endLine - hits[0].startLine + 1,
})
```

**Embed** chunks with the injected batch embedder — the one `embed` option
serves the indexing pass and (as single-item batches) query embedding.
Vectors live in a per-content cache (`fs_chunk_embeddings`, keyed by the
chunk's content hash) that only an explicit pass fills — never the write
path. The pass is **version-scoped** like every other operation on the
handle: it embeds what the instance's current version serves (honoring its
excludes/mounts), so branch → index → promote makes the new main fully
indexed the moment it becomes visible, and stale or abandoned versions
never cost an embedding call:

```ts
const fs = new PgFileSystem({
  db, workspaceId,
  chunking: { volatileFrontmatterKeys: ["fetchedAt"] }, // keep re-crawls cache-stable
  embed: (texts) => myEmbeddingApi.batch(texts),        // one vector per text
  embeddingDimensions: 1024,
})

const branch = await fs.fork("crawl")
// ... writes (chunks ride along) ...
await branch.indexChunkEmbeddings()
// { chunks: 120, cacheHits: 118, embedded: 2 } — only changed sections embed
await branch.promoteTo("main")
```

Requires `setup()` with `enableVectorSearch: true` + `embeddingDimensions`.
The cache is content-addressed and has no FK to the chunk rows on purpose:
identical sections anywhere in the workspace share one vector, and content
that comes back after a sweep or revert still cache-hits. Keys listed in
`volatileFrontmatterKeys` are stripped from the front-matter chunk's
*indexed* content (line ranges and bodies stay exact), so a re-crawl that
only bumps a timestamp re-embeds nothing.

**Semantic search** ranks the embedded chunks by cosine similarity.
Nearest-neighbor: it always ranks something, so irrelevant queries return
low-rank hits, not nothing — and chunks not yet embedded are invisible to it:

```ts
const similar = await fs.semanticSearch("how do refunds work", { limit: 10 })
```

**Hybrid search** fuses both signals (needs the full-text-search *and*
vector setups): the BM25 and embedding rankings are combined with
reciprocal-rank fusion — rank-based, not score-based, because BM25 scores
and cosine similarities aren't on comparable scales — so an exact rare
token and a synonym-only paraphrase each still surface, and chunks without
a cached embedding stay reachable through the lexical side:

```ts
const hits = await fs.hybridSearch("delivery options", { perFileCap: 2 })
// same result shape as textSearch()/semanticSearch()
```

**`semgrep`** puts all of this inside a [just-bash](https://www.npmjs.com/package/just-bash)
session, so an agent's shell searches without leaving bash. The command
dispatches on the handle: with an `embed` option it searches hybrid, without
one it is BM25-only — same usage either way, and the line ranges hydrate
with the session's own tools (`sed -n 12,34p file`):

```ts
import { createSemgrepCommand } from "bash-gres/just-bash"

const bash = new Bash({ fs, customCommands: [createSemgrepCommand({ fs })] })
await bash.exec('semgrep -k 3 "delivery options" /docs')
// /docs/shipping.md:12-34  [0.0323]  Shipping > Costs — Shipping is free over…
// one hit per line; exit 1 when nothing matches, like grep
```

**Migrate** an existing deployment in two idempotent steps:

1. Re-run `setup(client)` — it creates `fs_blob_chunks` (no new extensions).
   Drizzle users: re-run `drizzle-kit generate` (the table is in
   `createSchema()`) plus `generateMigrationSQL()` for RLS and the blob FK.
2. Index pre-existing content: `await fs.backfillChunks()` — chunks the
   blobs visible at the handle's version; content-addressed, safe to re-run.

Enabling `chunking` against a database that skipped step 1 fails fast with an
error explaining exactly this; older bash-gres versions keep working against
a migrated database (they simply never touch the table, and chunk rows are
cleaned up by the FK cascade when blobs are deleted).

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
bash-gres/just-bash      createSemgrepCommand (semantic grep for just-bash sessions)
```

## Development

```sh
docker compose up -d   # start postgres on localhost:5434
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/bashgres_test npm test
npm run typecheck      # type check
npm run build          # compile to dist/
```

## Docs

Full documentation at [bashgres.com/docs](https://bashgres.com/docs).

Upgrading from 2.x? See the [migration guide](https://bashgres.com/docs/migration) —
or, if a coding agent is doing the upgrade, point it at
[`UPGRADE-GUIDE.agents.md`](./UPGRADE-GUIDE.agents.md) (setting up fresh:
[`SETUP-GUIDE.agents.md`](./SETUP-GUIDE.agents.md)).

## License

[MIT](LICENSE)
