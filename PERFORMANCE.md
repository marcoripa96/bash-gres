# Performance

This document tracks performance work on `bash-gres` after the copy-on-write
(COW) versioning rework. Each item describes:

- **Why**: the observed cost in the current code, with file:line references.
- **Change**: what we plan to do, or what already landed.
- **Test**: how we verify correctness and the expected win.

The pre-COW `fs_nodes` plan is intentionally removed. Current storage is split
across `fs_versions`, `version_ancestors`, `fs_entries`, and content-addressed
`fs_blobs`.

All round-trip counts assume one connection per transaction. `npm run bench`
reports SQL statements issued through `SqlClient.query()` inside the operation;
adapter-owned `BEGIN`/`COMMIT` round-trips are not included in that query count.
Latency estimates: ~0.3ms localhost, ~3-5ms LAN.

## Current Baseline

Every public method goes through `withWorkspace()`
(`lib/core/filesystem.ts:346-358`) unless it is already using a transaction-bound
facade. The outer transaction path is `runInWorkspace()`
(`lib/core/filesystem.ts:325-337`), which opens a transaction, runs a dedicated
`SELECT set_config(...)` for `app.workspace_id` and `statement_timeout`, runs the
operation, and commits.

Cheapest op floor with a cached version ID and one work query: **4 round-trips**
(BEGIN + `set_config` + work + COMMIT). First use of a `PgFileSystem` instance
usually adds a version-label lookup (`getCurrentVersionId()`,
`lib/core/filesystem.ts:362-377`).

COW changes the hot path:

- Visible-entry reads resolve through `version_ancestors` and `fs_entries` using
  nearest-ancestor selection (`resolveEntry()`, `lib/core/filesystem.ts:511-539`).
- Directory and subtree reads merge inherited and shadowing rows with
  `DISTINCT ON (e.path) ... ORDER BY e.path, a.depth ASC`
  (`listVisibleChildren()`, `lib/core/filesystem.ts:581-612`, and
  `listVisibleSubtree()`, `lib/core/filesystem.ts:669-703`).
- File bytes live in `fs_blobs`; metadata operations should not touch blob
  payload columns.
- Writes upsert a content-addressed blob, then upsert a path entry in the current
  version only (`internalWriteFile()`, `lib/core/filesystem.ts:1008-1062`).
- Deletes write tombstones in the current version instead of deleting inherited
  rows (`writeTombstone()`, `lib/core/filesystem.ts:959-978`).
- `fork()` is O(ancestor depth), not O(file count): it inserts one version row
  and closure rows copied from the parent (`lib/core/filesystem.ts:2428-2480`).

## Landed With COW

### O(file-count) fork is gone

**Why.** Pre-COW fork copied every node row into the new version. Fork latency and
storage were both linear in workspace size.

**Change.** Versions are live overlays linked by `fs_versions.parent_version_id`
and materialized into `version_ancestors`. A fork does not copy entries or blobs;
it copies only the parent ancestor chain.

**Test.** `bench/results.md` records fork after 100, 1000, and 5000 files. The
COW branch stays single-digit milliseconds while the old branch grows linearly.

---

### Metadata operations avoid blob payloads

**Why.** The old `fs_nodes` row contained metadata, text content, binary data,
and embedding in one row. Metadata operations could accidentally materialize
large TOAST payloads.

**Change.** Entry metadata now lives in `fs_entries`; file content and embeddings
live in `fs_blobs`. `mv()` copies entry shapes and tombstones paths without
selecting `content`, `binary_data`, or `embedding`
(`lib/core/filesystem.ts:1746-1843`). Symlink resolution also reads entries only
until the final blob fetch (`resolveEntryFollowSymlink()`,
`lib/core/filesystem.ts:541-563`).

**Test.** `tests/perf.test.ts` asserts `mv()` and symlink-chain reads do not
select blob payload columns from metadata queries.

---

### Embedding RPCs are outside write transactions

**Why.** Network embedding calls can take 100-500ms. Holding a DB transaction and
checked-out connection idle during that call caps write throughput at the pool
size divided by embed latency.

**Change.** `writeFile()` computes embeddings before entering the write
transaction (`lib/core/filesystem.ts:1476-1493`). `appendFile()` also calls the
embedding provider before the write transaction; if the file already exists, the
current implementation discards that precomputed value and reuses the existing
blob embedding rather than re-embedding merged content inside the transaction
(`lib/core/filesystem.ts:1496-1583`). `internalWriteFile()` accepts an embedding
value and never calls the provider itself.

**Test.** Existing embedding tests verify writes populate `fs_blobs.embedding`
when vector search is enabled. Follow-up perf guard: configure an embedder that
blocks on a promise, start concurrent writes/appends, and assert DB connections
are not held while the promise is pending. Existing-file appends should also stop
calling the embedder if they intentionally keep the old embedding.

## Open Work

### #1 Remove the dedicated context-setting round-trip

**Why.** `runInWorkspace()` (`lib/core/filesystem.ts:325-337`) issues a dedicated
`SELECT set_config(...), set_config(...)` in every top-level transaction. For
cheap reads such as `stat()` (`lib/core/filesystem.ts:1595-1604`) or `exists()`
(`lib/core/filesystem.ts:1587-1593`), that is one of the few SQL calls on the
critical path.

**Change.** Add an adapter-level way to install transaction-local settings as
part of transaction startup, or otherwise fuse settings into the first query in
a driver-safe way. Avoid relying on semicolon-joined multi-statements in core;
that is not equally safe across postgres.js, node-postgres, and Drizzle.

**Test.**

- Existing RLS/workspace-isolation tests pass.
- `npm run bench` shows query-count median for one-query reads drops by one.
- 1000 cached-version `stat()` calls on localhost show a median latency drop
  larger than run-to-run noise.

---

### #2 Encode write content once

**Why.** String writes currently encode the same content multiple times. Public
`writeFile()` validates size (`lib/core/filesystem.ts:1481-1484`),
`internalWriteFile()` validates again (`lib/core/filesystem.ts:1015`), and then
encodes again for hashing/size (`lib/core/filesystem.ts:1037-1042`).
`validateFileSize()` itself encodes strings (`lib/core/filesystem.ts:720-730`). A
10MB string write can therefore allocate several throwaway 10MB buffers before
the blob upsert.

**Change.** Normalize write input once into `{ content, bytes, sizeBytes }` at
the public boundary, validate that byte length once, and pass the bytes through
to `internalWriteFile()` for hashing and blob storage. Keep binary writes
zero-copy when the caller already supplies a `Uint8Array`.

**Test.**

- Existing write/stat/read tests pass for string and binary inputs.
- Add a regression test that writes a multi-byte string near `maxFileSize` and
  verifies the limit is enforced using byte length, not JS string length.
- Optional micro-benchmark: write a 10MB string 50 times and compare allocation
  count or median latency.

---

### #3 Bulk `mkdir -p` for COW entries

**Why.** Recursive `internalMkdir()` walks each path segment. For every segment it
calls `resolveEntry()` and, if missing, `upsertEntry()`
(`lib/core/filesystem.ts:1131-1154`). `mkdir -p /a/b/c/d/e` can therefore issue
roughly two queries per new level, plus transaction setup. COW removed
`parent_id`, so there is no parent wiring work left to justify per-level
inserts.

**Change.** Compute all prefix paths in TypeScript, fetch their visible entry
state in one query, fail if any visible prefix is not a directory, then bulk
insert only missing directories into `fs_entries` for the current version. The
insert can be one `INSERT ... SELECT FROM unnest($paths)` with `ON CONFLICT DO
NOTHING`.

**Test.**

- Existing `mkdir` tests pass, including file-in-the-way and existing-directory
  cases inherited from an ancestor version.
- New query-count test: `mkdir -p` with depth 10 issues a bounded number of
  inner queries, independent of depth.

---

### #4 Bulk subtree mutations (`cp -r`, directory `mv`, `rm -rf`)

**Why.** COW makes subtree operations metadata-only, but the implementation still
loops per node:

- `internalCp()` recurses through directories, calling `listVisibleChildren()`
  per directory and `upsertEntry()` per copied entry
  (`lib/core/filesystem.ts:1179-1285`).
- Directory `mv()` fetches the subtree once, then inserts every translated path
  and writes every tombstone one by one (`lib/core/filesystem.ts:1804-1827`).
- `rm -rf` fetches the subtree once, then writes one tombstone per path
  (`lib/core/filesystem.ts:1722-1729`).

A 1000-node tree is still thousands of round-trips even though no blob data is
copied.

**Change.** Use visible-subtree CTEs and set-based writes:

- `cp -r`: `INSERT INTO fs_entries SELECT translated_path, blob_hash,
  node_type, symlink_target, mode, size_bytes FROM visible_subtree`.
- Directory `mv`: one bulk insert for translated destination rows, then one bulk
  tombstone insert for source rows.
- `rm -rf`: one bulk tombstone insert for all visible rows under the scope.

Keep current semantic checks before the bulk write: source exists, recursive flag
for directories, destination not inside source, destination compatibility, parent
visibility, and `maxCpNodes` enforcement.

**Test.**

- Existing `cp`, `mv`, and `rm` tests pass.
- Add a symlink-in-tree `cp -r` regression test to preserve `symlink_target`.
- Add query-count tests for 100-node `cp -r`, directory `mv`, and `rm -rf`; each
  should be bounded by a small constant inside the transaction.

---

### #5 Fast quota accounting under live COW overlays

**Why.** `validateNodeCount()` counts the current version's visible tree with a
closure join and `DISTINCT ON` for every single-path create
(`lib/core/filesystem.ts:732-750`). Batch operations already reduce this to one
global visible count (`globalVisibleCount()`, `lib/core/filesystem.ts:481-502`),
but single writes still pay a workspace-wide visibility scan.

The old counter-table idea is no longer directly correct. With live ancestor
overlays, a parent write can change a child's visible count unless the child has
shadowed that path.

**Change.** Design a COW-aware quota strategy before implementing. Candidate
directions:

- Maintain materialized visible counts and update affected descendants on parent
  writes, accepting O(descendants touched) write amplification.
- Maintain only owned-entry counts and use it for storage limits, while keeping
  visible-count checks as an optional stricter mode.
- Cache visible counts inside a transaction and invalidate on local writes, which
  helps batch-like API usage without changing cross-version semantics.

**Test.**

- Existing `maxFiles` tests pass for inherited entries, tombstones, forked
  versions, and parent writes after a fork.
- Concurrency test: parallel creates in the same version cannot exceed the limit.
- Cross-version test: a parent create after a child fork is reflected in the
  child's visible quota unless the child has shadowed that path.

---

### #6 Tune COW visibility indexes

**Why.** Most reads now depend on nearest-visible-row queries over
`version_ancestors` and `fs_entries`. Current setup creates
`idx_fs_entries_path_version`, `idx_fs_entries_path_gist`,
`idx_fs_entries_blob_hash`, `idx_version_ancestors_depth`,
`idx_version_ancestors_reverse`, and `idx_fs_versions_parent`
(`lib/core/setup.ts:46-70`). Benchmarks show directory listing is the main COW
tradeoff: `readdir(/d)` at depth 10 with divergence is ~0.9ms slower than the
old full-copy model (`bench/results.md`).

**Change.** Use `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on representative
visibility queries before adding indexes. Likely candidates to test:

- Cover the ordered ancestor scan with `(workspace_id, descendant_id, depth,
  ancestor_id)` so the join has `ancestor_id` without heap fetches.
- Revisit whether `idx_fs_entries_path_version` is still pulling its weight next
  to the primary key `(workspace_id, version_id, path)` and the ltree GiST index.
- Evaluate a workspace-scoped ltree index if benchmarks show cross-workspace
  GiST scans are material.

**Test.**

- Existing read, readdir, walk, glob, search, and versioning tests pass.
- EXPLAIN snapshots for `resolveEntry`, `listVisibleChildren`, and
  `listVisibleSubtree` at depth 1, 10, and 50 show no unexpected seq scans or
  large sorts.
- `bench/perf.ts` readdir scenario improves or stays within noise.

---

### #7 Vector index setup toggle

**Why.** `vectorDDL()` hardcodes an HNSW index on `fs_blobs.embedding`
(`lib/core/setup.ts:97-108`), and the Drizzle schema does the same
(`lib/adapters/drizzle/schema.ts:132-138`). HNSW gives good recall but has
meaningful insert cost. Write-heavy agent workloads may prefer IVFFlat or no
vector index.

**Change.** Add a `setup()` option:

```ts
vectorIndex?: { kind: "hnsw"; m?: number; efConstruction?: number }
            | { kind: "ivfflat"; lists?: number }
            | { kind: "none" }
```

Default stays HNSW when `enableVectorSearch` is true. Mirror the option in the
Drizzle schema builder and document the insert/recall tradeoff in `README.md`.

**Test.**

- Existing semantic-search tests pass with default setup.
- New setup test: `{ kind: "ivfflat", lists: 100 }` creates an IVFFlat index as
  reported by `pg_indexes`.
- New setup test: `{ kind: "none" }` adds the vector column but skips the index;
  semantic search still works on a small dataset by scanning.

---

### #8 Streaming `walk()`

**Why.** `walk()` resolves the whole visible subtree and maps every row into an
array (`lib/core/filesystem.ts:1694-1704`). `listVisibleSubtree()` also returns a
full array (`lib/core/filesystem.ts:669-703`). A 100k-node subtree therefore
materializes the full SQL result and public `WalkEntry[]` at once.

**Change.** Add `walkStream(path, { batchSize? })` returning
`AsyncIterable<WalkEntry>`. Prefer keyset pagination by encoded ltree path, like
`diffStream()` (`lib/core/filesystem.ts:2272-2305`), so each batch uses a short
transaction and works across all adapters without server-side cursor APIs.
Document that the stream is not snapshot-isolated across the whole iteration;
callers that need a snapshot can keep using `walk()`.

**Test.**

- Existing `walk` tests pass.
- New test: `walkStream` over a 500-node tree yields the same ordered entries as
  `walk()`.
- New test: breaking out of iteration early does not leak transactions or
  connections.

---

### #9 Set-based `deleteVersion` blob GC

**Why.** `deleteVersionById()` deletes the version's entries, collects candidate
blob hashes, and then loops one `DELETE FROM fs_blobs ... NOT EXISTS` per hash
(`lib/core/filesystem.ts:2641-2703`). Deleting a version with many unique edited
files is therefore O(unique blobs) round-trips after the entry delete.

**Change.** Fold candidate collection and orphan-blob deletion into set-based
SQL. One shape is a writable CTE that deletes `fs_entries`, selects distinct
non-null returned hashes, deletes closure/version rows, then deletes from
`fs_blobs` where no remaining `fs_entries` row references each candidate hash.
Keep the existing advisory lock so concurrent writers in the same workspace do
not race GC.

**Test.**

- Existing version deletion and blob reuse tests pass.
- New test: deleting a version with shared and unique blobs removes only the
  unique unreferenced blobs.
- Query-count test: deleting a version with 1000 unique blobs uses a bounded
  number of inner SQL statements.

## Measurements

### Bench Protocol

Current branch micro-benchmark:

```sh
docker compose up -d
npm run bench
```

`npm run bench` runs `bench/run.ts` and prints median / p95 / p99 plus the
median count of SQL statements issued through `SqlClient.query()` inside each
operation.

COW-vs-old comparison benchmark:

```sh
docker compose up -d
BENCH_LABEL=cow-redesign npx tsx bench/perf.ts
```

Run the same command on the old branch with `BENCH_LABEL=main` and compare the
appended tables in `bench/results.md`.

Hardware for the recorded COW comparison: localhost docker Postgres on
`localhost:5433`, postgres.js adapter, 1000-file workspaces unless noted.

### COW Rework Results (2026-04-28)

| Scenario | Old full-copy model | COW model | Result |
| --- | ---: | ---: | --- |
| `fork()` after 100 files | 15.5 ms | 6.0 ms | 2.6x faster |
| `fork()` after 1000 files | 74.0 ms | 6.1 ms | 12x faster |
| `fork()` after 5000 files | 324.7 ms | 2.4 ms | 130x faster |
| `readFile()` at chain depth 50, median | 0.40 ms | 0.74 ms | +0.34 ms |
| `readFile()` at chain depth 50, p95 | 0.53 ms | 1.15 ms | +0.62 ms |
| 1000 files + fork + 1 edit, entry rows | 1001 -> 2002 | 1001 -> 1002 | -1000 rows |
| 1000 files + fork + 1 edit, DB bytes | +1.02 MiB | +0 B | storage win |
| `deleteVersion` (1000 files, 100 edited) | 42.8 ms | 23.4 ms | 1.8x faster |
| `readdir(/d)` at depth 10, median | 1.17 ms | 2.09 ms | +0.92 ms |

Takeaways:

- The headline COW wins are fork latency and storage: fork is independent of
  file count, and fork-plus-small-edit does not duplicate entry/blob rows.
- Read overhead stays in the same order of magnitude even at depth 50.
- Directory listing is the main cost of live overlays because it must merge
  inherited and shadowing rows. That is why visibility-index work is now higher
  priority than the old `fs_nodes` parent-index item.

## Out Of Scope

These are real wins, but they need API design or broader behavior decisions
before implementation:

- Streaming reads/writes (`createReadStream`, `createWriteStream`).
- Batch public API for many path operations in one transaction.
- Statement timeout per operation rather than per `PgFileSystem` instance.
- Prepared statement caching, which is driver-specific.
