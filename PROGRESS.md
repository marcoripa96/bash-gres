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

- [ ] Public versioning types in `lib/core/types.ts` (`NodeType`, `EntryShape`, `VersionDiffEntry`, `MergeStrategy`, `ConflictEntry`, `MergeResult`, `RenameVersionResult`, `PromoteResult`)
- [ ] Re-export new types from `lib/core/index.ts`
- [ ] Convert `version` to a getter backed by mutable `versionLabel`
- [ ] Split `withWorkspace()` into `runInWorkspace(client, fn)` + `withWorkspace(fn)`
- [ ] Transaction-bound `PgFileSystem` facade with post-commit hooks
- [ ] Shared visible-entry helpers (`fetchVisibleSubtree`, entry-shape mapper)
- [ ] Entry-shape writer (`writeEntryShape`)
- [ ] Parent-directory expansion helper for batch applies
- [ ] Batch node-count validation
- [ ] Entry equality helper (`node_type`, `blob_hash`, `mode`, `symlink_target`)
- [ ] Advisory lock helper for version mutation
- [ ] Version lookup helpers (`getVersionIdByLabel`, `requireVersionIdByLabel`)

## Phase 2 - `transaction(fn)`

- [ ] Implement `PgFileSystem.transaction()`
- [ ] Tests: commit, rollback, readonly rejects writes, nested calls share the outer tx, post-commit label mutation

## Phase 3 - `diff()` / `diffStream()`

- [ ] Implement `diff()` with FULL OUTER JOIN over visible CTEs
- [ ] Implement `diffStream()` with keyset pagination
- [ ] Tests: added / removed / modified / type-changed / mode-only / symlink target / scope / rootDir / streamed pagination

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
