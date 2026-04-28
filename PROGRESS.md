# Versioning primitives - implementation progress

Tracks progress against [VERSIONING_PRIMITIVES.md](./VERSIONING_PRIMITIVES.md).
Branch: `feat/versioning-primitives`.

## Status legend

- [ ] not started
- [~] in progress
- [x] complete

## Phase 0 - Pin semantics

- [x] Document live-overlay decision in README (fork is O(1) ancestor overlay, not a copy)
- [x] Add tests pinning live-overlay behavior: parent writes after fork remain visible to the child unless the child has shadowed the path (see `tests/cow.test.ts > "live ancestor overlay"`)
- [x] Confirm O(1) fork tests still pass (cow.test.ts: 75/75; versioning.test.ts: 36/36)
- [x] Decision: keep O(1) live-overlay fork. `detach()` is the materialization escape hatch. No DDL changes needed.

## Phase 1 - Shared refactor

- [x] Public versioning types in `lib/core/types.ts` (`NodeType`, `EntryShape`, `VersionDiffEntry`, `MergeStrategy`, `ConflictEntry`, `MergeResult`, `RenameVersionResult`, `PromoteResult`)
- [x] Re-export new types from `lib/core/index.ts`
- [x] Convert `version` to a getter backed by mutable `versionLabel`
- [x] Split `withWorkspace()` into `runInWorkspace(client, fn)` + `withWorkspace(fn)` so a transaction-bound facade can reuse it
- [ ] Transaction-bound `PgFileSystem` facade with post-commit hooks (deferred to Phase 2 where it's wired up)
- [ ] Shared visible-entry helpers / entry-shape mapper (deferred to Phase 3 where diff/merge first need them)
- [x] Entry-shape writer (`writeEntryShape`) and `InternalEntryShape` row type
- [ ] Parent-directory expansion helper for batch applies (deferred to Phase 6 where merge first needs it)
- [ ] Batch node-count validation (deferred to Phase 6)
- [x] Entry equality helper (`entryShapeEqual` over `node_type`, `blob_hash`, `mode`, `symlink_target`)
- [x] Advisory lock helper for version mutation (`lockVersions`)
- [x] Version lookup helpers (`getVersionIdByLabel`, `requireVersionIdByLabel`)

Notes: deferred items have unambiguous design but will be authored alongside their first consumer to avoid speculative dead code. They're tracked here so we don't lose them.

## Phase 2 - `transaction(fn)`

- [x] Implement `PgFileSystem.transaction()` with a transaction-bound facade (private `txClient` field, `createTxFacade()`)
- [x] `withWorkspace()` short-circuits to `txClient` when set, so all public methods called on the facade reuse the outer transaction
- [x] Re-entrant: `transaction()` on a facade returns the same facade
- [x] `fork()` inside a transaction returns a tx-bound child so subsequent writes on the new branch stay in the outer tx
- [x] Tests in `tests/transaction.test.ts`: commit, rollback, return value, nested calls share outer tx, readonly rejects writes (EPERM), RLS isolation, rootDir preservation
- [ ] Post-commit label mutation hook (deferred to Phase 5 with `renameVersion()`)

## Phase 3 - `diff()` / `diffStream()`

- [x] Implement `diff()` with FULL OUTER JOIN over two `DISTINCT ON` visible-entry CTEs (tombstones filtered out at the CTE level)
- [x] Implement `diffStream()` with keyset pagination by encoded ltree path; per-batch transaction; `batchSize` clamped to [1, 5000]
- [x] Direction documented: `before` is current, `after` is `other`. Equality on `node_type`, `blob_hash`, `mode`, `symlink_target`. `mtime`/`size_bytes` ignored
- [x] Tests in `tests/diff.test.ts` (48 cases × 3 adapters): added / removed / modified / type-changed / mode-only / symlink target / mtime ignored / sibling versions / subtree scope / single-file scope / rootDir / unknown version error / streaming round-trip / clamped batchSize
- Full suite green: 597/597

## Phase 4 - `detach()`

- [ ] Implement subtree-safe `detach()` (materialize inherited entries, rewrite closure rows, clear `parent_version_id`, drop redundant tombstones)
- [ ] Tests: identical visible contents before/after, descendant views unchanged, `parent_version_id` becomes NULL, former ancestors deletable, idempotent on root

## Phase 5 - `renameVersion()` & `promoteTo()`

- [ ] Implement `renameVersion(label, opts)` with `swap`
- [ ] Implement `promoteTo(label, opts)` sugar (detach + renameVersion + optional deleteVersion)
- [ ] Tests: rename to unused / existing / swap / rollback preserves label / promote E2E with `dropPrevious`

## Phase 6 - `merge()`

- [ ] LCA query
- [ ] Three-way classification + conflict matrix
- [ ] Strategies: `fail`, `ours`, `theirs`
- [ ] `paths`, `pathScope`, `dryRun`
- [ ] Directory-deletion expansion to descendants
- [ ] Tests: full conflict matrix per acceptance list

## Phase 7 - `cherryPick()` & `revert()`

- [ ] Implement `cherryPick(source, paths)` (source-wins two-way)
- [ ] Implement `revert(target, opts)` (rollback restore)
- [ ] Tests: file / directory / missing / parent expansion / equal-skip / empty-paths
