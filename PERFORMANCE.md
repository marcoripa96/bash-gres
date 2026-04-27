# Performance

This document tracks performance work on `bash-gres`. Each item describes:
- **Why**: the observed cost in the current code, with file:line references.
- **Change**: what we plan to do (or did).
- **Test**: how we verify the change is correct and provides the expected win.

All round-trip counts assume `pg.Pool` with one connection per transaction. RTT
estimates: ~0.3ms localhost, ~3-5ms LAN.

## Baseline

Every public method goes through `withWorkspace` (`lib/core/filesystem.ts:137`),
which opens a `BEGIN`, runs a dedicated `SELECT set_config(...)` to set
`app.workspace_id` and `statement_timeout`, runs the work, and `COMMIT`s.

Cheapest op floor: **4 round-trips** (BEGIN + set_config + work + COMMIT).
On localhost ~2ms; on LAN ~15-25ms. With a default pool of 10, single-tenant
ceiling is ~400-650 ops/sec.

---

## #1 Hoist `embed()` outside the transaction

**Why.** `internalWriteFile` (`lib/core/filesystem.ts:411-414`) `await`s
`this.embed(content)` while the transaction is open and a connection is
checked out. Embedding providers typically respond in 100-500ms; for that
entire window the connection sits idle. With a pool of 10 and 200ms embeds,
sustained write throughput caps at ~50 writes/sec — bottlenecked on the
embedder while DB connections do nothing.

`writeFile` already pre-computes the embedding before `withWorkspace`
(`:690-694`) and passes it via `precomputedEmbedding`. The fallback path in
`internalWriteFile` is reached from `appendFile` text-merge (`:751`) and
`link` (`:1233`), and it shouldn't exist at all — silently doing network I/O
inside a transaction is the kind of thing you only discover under load.

**Change.**
- Make `internalWriteFile`'s embedding parameter required (no auto-embed
  fallback). Type: `number[] | null`.
- Refactor `appendFile`: read existing content under a row lock in txn 1,
  release, embed merged content, write in txn 2 — same correctness using
  `INSERT ... ON CONFLICT DO UPDATE` and the existing unique constraint.
- `link` and recursive `cp`: pass `null` (these copies don't carry the
  source's embedding today either; tracking as a separate concern).

**Test.**
- Existing test suite passes.
- New test: `writeFile` with `embed` configured produces a row whose
  `embedding` column is non-null. (Spec calls for "one file works" — no
  benchmark of embedding throughput.)

---

## #2 `getNodeForUpdate` returns metadata only

**Why.** `getNodeForUpdate` (`lib/core/filesystem.ts:198-211`) does
`SELECT *`, which includes `content`, `binary_data`, and `embedding`. The
function is called from `mv` (`:1045`), which only updates `name`, `path`,
and `parent_id` — it never reads content. Moving a 10MB file therefore pulls
10MB of TOASTed bytes into Node memory just to update three columns.
`resolveSymlink` (`:218`) has the same shape: it only needs `node_type` +
`symlink_target` but pays for the full row.

**Change.**
- Add `getNodeMetaForUpdate` returning the same columns as `getNodeMeta` plus
  `FOR UPDATE`.
- Switch `mv` and `resolveSymlinkMeta` to it. `link` and `internalCp` keep
  using `getNode` since they actually need content.

**Test.**
- Existing tests pass.
- New test: `mv` of a 5MB file completes without materializing content (we
  can't observe bandwidth directly, but a regression test that asserts the
  new helper exists and is used keeps callers honest).

---

## #3 Combine `set_config` with first transaction query

**Why.** `withWorkspace` (`lib/core/filesystem.ts:138-144`) issues a
dedicated `SELECT set_config(...), set_config(...)` per transaction. That's
one round-trip on the critical path of *every* public method. For a `stat`
call on localhost, it's ~25% of the total latency.

`set_config(name, value, true)` is a pure function — its return value is the
new setting. We can prepend it as a separate statement to the first work
query, or pipe it via the extended-protocol pre-amble. Postgres also supports
multi-statement simple queries, but the supported drivers (postgres.js,
node-postgres, drizzle) all use extended protocol per call.

The cleanest portable shape: change `withWorkspace` to defer the
`set_config` until the first inner query and bundle them. We expose a
`txWithContext` helper that wraps `tx.query`/`tx.transaction` and prepends
the `set_config` selects to the first call only, then becomes a passthrough.

**Change.**
- New helper in `withWorkspace` that wraps `tx` so the first `query` call
  prepends `SELECT set_config(...); SELECT set_config(...);` as separate
  semicolon-joined statements ahead of the user query. Subsequent calls are
  passthrough. Need to confirm each adapter executes multi-statement text;
  postgres.js does, pg does only via simple-query mode, drizzle defers to
  the underlying driver.
- Fallback: if multi-statement is not safe across all adapters, send the
  set_config as the first call but in parallel with `BEGIN` using a single
  `BEGIN; SET LOCAL ...; SET LOCAL ...;` text query — that's pipelined as
  one round-trip in postgres.js. For node-postgres, use `simpleQuery` mode.

**Test.**
- Existing tests pass.
- Latency micro-benchmark: 1000 `stat` calls on localhost, before/after.
  Expect ~20-25% reduction in median latency.
- Workspace isolation test still passes (RLS still gets the setting).

---

## #4 Single-statement `mkdir -p`

**Why.** `internalMkdir` recursive branch (`lib/core/filesystem.ts:485-502`)
does one SELECT to find existing levels, then loops one INSERT per missing
level. `mkdir -p /a/b/c/d/e` is 1 + 5 = 6 round-trips. Within a transaction
the cost is mostly latency, not work.

A bulk INSERT can do all levels in one statement using `unnest` over arrays
of paths and parent paths, with a self-join to find each parent's id.

**Change.**
- Replace the per-level INSERT loop with one
  `INSERT ... SELECT FROM unnest($paths, $names, $parent_paths) ON CONFLICT
  ... DO NOTHING`, joined against `fs_nodes` to look up parent ids.
- Watch out: parent ids depend on the just-inserted row above. Either order
  by depth and use `RETURNING id` chained, or compute ids via a recursive
  CTE in one statement.

**Test.**
- Existing `mkdir` tests pass.
- New test: `mkdir -p` with depth 10 issues a bounded number of queries
  (instrument `tx.query` count via the adapter; expect ≤2 inside the txn,
  excluding BEGIN/COMMIT/set_config).

---

## #5 Replace `COUNT(*)` quota check with a counter table

**Why.** `validateNodeCount` (`lib/core/filesystem.ts:296-307`) does
`SELECT COUNT(*) FROM fs_nodes WHERE workspace_id = $1 AND version = $2` on
every `writeFile` whose path doesn't already exist (`:397`). That's a sequential
or index-only scan over the workspace's node set on every new-file write. On
a 100k-file workspace that's milliseconds of avoidable work per write, plus
heap fetches if the visibility map is stale.

**Change.**
- New table `fs_workspace_usage(workspace_id, version, file_count)` with
  primary key `(workspace_id, version)`.
- Increment on insert, decrement on delete (within the same transaction).
- Use it for the quota check.
- Bonus: lays the groundwork for a public `usage()` API
  (`FOLLOWUPS.md` #10).

**Test.**
- Existing quota tests pass.
- New test: counter stays in sync across mixed write/delete/rm-rf/cp/mv ops.
- Concurrency test: two parallel writes to the same workspace land with
  count=2 (counter increments serialize via row lock on the usage row).

---

## #6 Single-statement `cp -r`

**Why.** `internalCp` (`lib/core/filesystem.ts:548-593`) recurses one node
at a time: `getNode` per source, `internalWriteFile` per destination, plus
`mkdir -p` per intermediate directory. A 1000-node tree copy is ~3000 round
trips. The `MAX_CP_NODES = 10_000` cap (`:71`) is a band-aid for this
slowness.

The whole subtree can be copied in two statements using ltree path rewriting:

```sql
INSERT INTO fs_nodes (workspace_id, version, parent_id, name, node_type,
                      path, content, binary_data, symlink_target, mode,
                      size_bytes, mtime)
SELECT workspace_id, version, NULL, name, node_type,
       ($dest_lt::ltree || subpath(path, nlevel($src_lt::ltree))) AS path,
       content, binary_data, symlink_target, mode, size_bytes, now()
FROM fs_nodes
WHERE workspace_id = $ws AND version = $v AND path <@ $src_lt::ltree;
```

Then a follow-up UPDATE to wire `parent_id` for the new rows from their new
paths.

This also fixes the symlink-loses-its-targetness bug we flagged in the audit:
`symlink_target` is now copied verbatim.

**Change.**
- Replace recursive `internalCp` with bulk INSERT + parent_id fixup.
- Keep `MAX_CP_NODES` enforcement via an upfront COUNT (or via the inserted
  row count and rollback if exceeded).
- Embedding column: copy as-is when the column exists. (Source and dest are
  the same workspace/version target, embeddings remain valid.)

**Test.**
- Existing `cp` tests pass (cover files, dirs, recursive, errors).
- New test: `cp -r` of a tree containing a symlink preserves it as a symlink
  with the same target.
- New test: round-trip count for 100-node `cp -r` is bounded (≤4 statements
  inside the txn).

---

## #7 Add `version` to `idx_fs_workspace_parent`

**Why.** The index is `(workspace_id, parent_id)`
(`lib/core/setup.ts:50-51`) but every readdir/mv/rm query filters on
`(workspace_id, version, parent_id)`. The planner uses the index for
workspace + parent and applies version as a heap filter. On multi-version
workspaces, this re-reads the heap pages of all sibling versions just to
discard them.

**Change.**
- `DROP INDEX idx_fs_workspace_parent; CREATE INDEX idx_fs_workspace_parent
  ON fs_nodes (workspace_id, version, parent_id)`.
- Add migration entry to `MIGRATE_DDL`.

**Test.**
- Existing readdir/mv/rm tests pass.
- New test: `EXPLAIN (FORMAT JSON)` of a readdir query on a workspace with
  ≥2 versions shows the index is used and no `Filter` on version remains.

---

## #8 HNSW vs IVFFlat trade-off + setup toggle

**Why.** `vectorDDL` (`lib/core/setup.ts:86-98`) hardcodes HNSW with
`m=16, ef_construction=64`. HNSW gives best recall but its insert cost is
substantial — every write touches multiple graph layers, and the cost grows
with index size. For write-heavy workloads (agents constantly editing
files), IVFFlat is typically 5-10x faster on inserts at the cost of recall
that needs periodic `REINDEX`.

There's no way to opt out today, and the README doesn't mention the write
penalty.

**Change.**
- New `setup` option:
  ```ts
  vectorIndex?: { kind: "hnsw"; m?: number; efConstruction?: number }
              | { kind: "ivfflat"; lists?: number }
              | { kind: "none" }
  ```
  Default stays `hnsw` for back-compat.
- Document the trade-off in README under a "Vector index" section.

**Test.**
- Existing semantic-search tests pass with default.
- New test: setup with `vectorIndex: { kind: "ivfflat", lists: 100 }`
  creates the IVFFlat index (verify via `pg_indexes`) and a basic semantic
  search returns results.
- New test: `vectorIndex: { kind: "none" }` skips the index; query still
  works (sequential scan) on a small dataset.

---

## #9 Reuse encoded bytes in `writeFile`

**Why.** `internalWriteFile` (`lib/core/filesystem.ts:284-294, 404-406`)
calls `new TextEncoder().encode(content)` twice: once in `validateFileSize`
and once to compute `size_bytes`. For a 10MB string that's 2x the encoding
work and 2x the throwaway buffer allocation.

**Change.**
- `validateFileSize` returns the encoded byte length (or accepts an
  already-encoded `Uint8Array`).
- Call it once at the top of `internalWriteFile`, store the byte count, use
  it for the INSERT.

**Test.**
- Existing tests pass.
- New test: a 1MB string write produces correct `size` via `stat` (already
  covered, but reaffirm under the new code path).

---

## #10 Cursor-based `walk()` async iterator

**Why.** `walk` (`lib/core/filesystem.ts:920-944`) materializes the entire
subtree as `WalkRow[]` then maps it to `WalkEntry[]`. For a 100k-node
subtree the agent process holds two arrays of 100k objects in memory while
the DB streams rows back. Memory is bounded by the agent, not the DB.

`pg` driver supports server-side cursors (`pg-cursor`), and `postgres.js`
exposes async iteration via `.cursor()`. We can expose a streaming variant.

**Change.**
- Keep existing `walk(path)` returning `WalkEntry[]` for back-compat.
- Add `walkStream(path, options?)` returning `AsyncIterable<WalkEntry>`.
- Implementation uses `DECLARE ... CURSOR FOR ...; FETCH FORWARD N FROM ...`
  in chunks (works across all three adapters since `DECLARE CURSOR` is
  driver-agnostic). Default chunk size 200.

**Test.**
- Existing `walk` tests pass.
- New test: `walkStream` over a 500-node tree yields all entries in path
  order, identical content to `walk`.
- New test: `walkStream` with `break` mid-iteration releases the cursor
  (verify by checking no leaked transactions / connections after several
  iterations).

---

## Measurements

`npm run bench` runs the workload defined in `bench/run.ts` against a live
postgres on `$TEST_DATABASE_URL`. Numbers below are median wall-clock
milliseconds and the median count of SQL statements issued *inside*
`withWorkspace` (one round-trip each).

Hardware: localhost docker postgres, pgvector/pgvector:pg18, 200 iterations
unless the scenario caps lower. Run `BENCH_ITERATIONS=N npm run bench` to
override.

### Baseline (commit `75c993c`, pre-perf-work)

```
scenario                  n    median ms  p95 ms  p99 ms  queries
stat (existing file)      200  0.55       0.86    1.05    2
writeFile 1KB (no embed)  200  2.81       3.79    4.28    6
readFile 1KB              200  0.44       0.71    1.23    2
mv 1MB file               50   20.75      23.15   23.62   11
mkdir -p depth 8          200  4.92       6.18    7.05    10
cp -r 50-node tree        20   62.47      79.34   79.34   261
readdir 100-entry dir     200  0.74       0.94    1.12    3
walk 200-node tree        100  2.33       3.16    7.49    3
```

### After #1 + #2

```
scenario                  n    median ms  p95 ms  p99 ms  queries
stat (existing file)      200  0.45       0.74    1.08    2
writeFile 1KB (no embed)  200  2.68       3.30    4.04    6
readFile 1KB              200  0.44       0.56    1.11    2
mv 1MB file               50   16.31      20.77   22.62   11
mkdir -p depth 8          200  5.11       7.30    9.41    10
cp -r 50-node tree        20   59.96      65.96   65.96   261
readdir 100-entry dir     200  0.66       0.90    2.51    3
walk 200-node tree        100  2.42       2.97    4.27    3
```

Headline change: `mv 1MB file` 20.75 ms → 16.31 ms (**-21%**). The win
comes from #2 dropping the SELECT * fetch on the source row; the file's
1 MB of bytes used to flow through the wire and Node's heap, now they
don't. Other scenarios are within noise of the baseline since #1's win
shows up only when the embedder is actually configured (not part of the
default bench), and #2's win on non-`mv` paths is bandwidth, not
round-trips.

`stat`, `readFile`, `readdir`, and `walk` all still issue an extra
`set_config` round-trip — see #3, which is expected to drop them by one
query each.

## Out of scope

These are real wins but blocked or contentious — tracked in `FOLLOWUPS.md`:

- Streaming reads/writes (`createReadStream`) — needs API design.
- Batch API — needs API design.
- `ON DELETE CASCADE` for `rm -rf` — changes failure modes; defer.
- Statement timeout per operation — needs API design.
- Prepared statement caching — driver-specific.
