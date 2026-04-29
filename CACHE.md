# Cache adapter layer

Read-side caching for `PgFileSystem`. Opt-in via the `cache` constructor
option; no behavior change when omitted.

## What landed

### Public surface

- `FsCache` interface — `lib/core/cache.ts`. Four methods, byte-oriented,
  opaque keys: `get`, `set(ttlMs?)`, `delete(keys[])`, `clear(prefix)`.
- `InMemoryFsCache` — `lib/core/cache-memory.ts`. LRU with byte budget
  (default 64 MiB). Single-process; safe to share across `PgFileSystem`
  instances in the same process.
- `PgFileSystemOptions.cache?: FsCache` and `cacheTtlMs?: number`.

```ts
import { PgFileSystem, InMemoryFsCache } from "bash-gres";

const cache = new InMemoryFsCache({ maxBytes: 64 * 1024 * 1024 });
const fs = new PgFileSystem({ db, workspaceId, cache });
```

### Read methods cached

`stat`, `lstat`, `exists`, `realpath`, `readFile`, `readFileBuffer`,
`readdir`, `readdirWithFileTypes`, `readdirWithStats`, `walk`.

`readFileLines` **piggybacks** on the `readFile` cache:

- On hit: slice the cached blob in memory, return the requested lines.
  Binary-tagged entries throw `EINVAL` to match the SQL path.
- On miss: fall through to the DB. **No** per-range cache entry is stored.
  **No** backfill of the full-file cache from a line read.

### Mutations invalidate

`writeFile`, `appendFile`, `mkdir`, `rm`, `cp`, `mv`, `chmod`, `utimes`,
`symlink`, `link`, `init`, `dispose`, `merge`, `cherryPick`, `revert` —
clear the current `workspaceId\x01versionLabel\x01` prefix on commit.

`renameVersion` — clears the *old* prefix (captured before the label moves).

`deleteVersion` — clears the deleted version's prefix.

`fork`, `detach`, `getUsage` — no invalidation; they don't change visible
state of the current version.

## Correctness rules

These are the three footguns the design review flagged:

1. **Bypass inside `transaction(fn)`.** When `txClient !== null`, reads skip
   the cache entirely so the facade sees its own uncommitted writes
   (read-your-writes within a transaction).
2. **Invalidation runs only on commit.** Mutations on a facade push the
   `cache.clear(prefix)` call onto `postCommitHooks`. The hooks run only if
   `transaction()` returns successfully; on rollback they're discarded.
   Top-level mutations clear immediately because `withWorkspace` resolves
   only after `COMMIT`.
3. **Keys are RLS-shaped.** Every key is mandatorily prefixed with
   `workspaceId\x01versionLabel\x01...`. Two `PgFileSystem` instances sharing
   one cache cannot read each other's entries across workspaces or versions.

## Tests

`tests/cache.test.ts`, 48 tests × 3 SQL adapters. Coverage:

- Hit/miss for `stat`, `readFile`, `readFileBuffer`, `exists`, `readdir`.
- Mutation invalidation (`writeFile`, `rm`).
- Rollback skips invalidation; commit fires it.
- Reads inside `transaction(fn)` bypass cache and see uncommitted writes.
- Workspace-pair isolation; version-pair isolation when sharing one cache.
- `readFileLines` piggyback rules: serves from full-file cache, no per-range
  entries stored, no backfill from line reads, trailing-newline parity.

Full suite: 870/870 passing.

## What's missing

### Deferred features

- **Redis adapter** (`bash-gres/redis` subpath export). The independent
  reviewers all argued in-memory should be the default and Redis a
  follow-up; ship it when there's a concrete multi-process need. The
  interface is already shaped to accommodate it (byte-oriented `get`/`set`,
  prefix `clear`).
- **In-memory per-process** is the only adapter today. No cross-process
  coherence. Two Node processes pointing at the same Postgres with separate
  `InMemoryFsCache` instances will not see each other's invalidations.

### Read paths not cached

- **`getUsage`** — invalidates on every write of any kind, so the hit rate
  is poor and the entry semantics are workspace-wide rather than path-keyed.
- **`readFileRange`** — parameter-heavy (`offset`, `limit`) with low key
  reuse; agents typically slide the window. Pulled the optimization out.
- **`search`** — cross-cutting; any content change invalidates every cached
  query. Not attempted.

### Negative results not cached

`stat`/`readFile` of a nonexistent path throws `ENOENT`. Errors are not
cached; misses re-query the DB until the path appears. Could be a hit-rate
win, but conflates "absent" with "error" and complicates invalidation —
deferred until there's evidence it matters.

### Known soft edges

- **Stale entries linger until LRU evicts them.** `cache.clear(prefix)`
  removes them eagerly for in-memory, but for a future Redis adapter the
  pattern would need `SCAN` + `DEL` which is O(n). Consider an epoch-counter
  scheme there instead.
- **Fork child inside `transaction(fn)`** schedules cache clears
  immediately rather than queuing to the outer commit, because the child
  doesn't inherit `postCommitHooks`. Not a correctness bug — at worst the
  cache loses entries that would have been valid; subsequent reads
  re-populate. Worth tightening if it shows up in profiling.
- **Heavy-write workloads** churn the cache. Coarse `(workspace, version)`
  invalidation was chosen over fine-grained per-path invalidation because
  symlinks, `cp -r`, `merge`, and `revert` make precise invalidation leaky.
  If write-heavy hit rate becomes a problem, refine — don't try to be
  clever from the start.

## Design rationale (one-liners, so we don't re-litigate)

- **Filesystem layer, not Bash.** Stable cache keys; bash strings aren't.
- **In-memory first.** Single-process is the dominant use case; Redis adds
  a network hop and a second consistency surface for no win until you have
  multi-process readers.
- **Coarse `(workspace, version)` invalidation.** Correct under the version
  graph, immune to symlink-induced non-locality, simple to reason about.
- **Adapter is dumb bytes.** Encoding, key composition, and TTL policy live
  in the wrapper, so a future Redis adapter and the in-memory `Map` share
  exactly the same shape.
