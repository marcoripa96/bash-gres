# Versioning primitives - architecture and implementation plan

Status: design proposal. Not yet implemented.

This document expands the versioning primitives into an implementation plan grounded in the current repository. The current code already has a PostgreSQL copy-on-write schema and a small public versioning API, but it does not yet expose the operations needed to promote, compare, merge, or safely rewrite version graphs.

## Current repo facts

- `PgFileSystem` lives in `lib/core/filesystem.ts` and is the only core runtime class.
- Core talks to a driver-agnostic `SqlClient` from `lib/core/types.ts`.
- Every public method currently opens its own transaction through `withWorkspace()`, which sets `app.workspace_id` and `statement_timeout`.
- Version labels are resolved to `fs_versions.id` lazily and cached in `cachedVersionId`.
- `version` is currently a public `readonly` property, so `renameVersion()` requires a small instance-state refactor.
- Visibility is per path: the closest ancestor row in `version_ancestors` wins; a closest `tombstone` hides that path.
- Writes only add or update rows in the current version's `fs_entries`; inherited rows stay in ancestor versions.
- `fork()` is O(1) and only writes `fs_versions` plus `version_ancestors`; it does not copy `fs_entries`.
- `deleteVersion()` refuses versions with direct children via `fs_versions.parent_version_id`, then deletes rows for that version and GCs blobs that are no longer referenced by any `fs_entries` row.
- The Drizzle schema and `setup()` DDL already contain the tables and indexes these primitives need. No DDL changes are required for the plan below.

## Important semantic constraint

The current O(1) fork model is a live ancestor-overlay model, not a historical snapshot model.

Because `fs_entries` has one row per `(workspace_id, version_id, path)` and ancestor rows are read live, a parent write after a child has been forked can affect the child's visible view unless the child has its own row or tombstone at that path. There is no historical row to reconstruct the parent's old value at fork time.

This matters for merge and revert semantics:

- The plan below defines `diff`, `merge`, `cherryPick`, and `revert` against the visible views at execution time.
- The LCA used by `merge()` is the current visible LCA view, not a historical fork-base snapshot.
- If true Git-like immutable fork snapshots are required while keeping O(1) fork, the schema needs history rows or valid-time ranges. That violates the current "no DDL changes" goal.
- If true Git-like snapshots are required without DDL changes, `fork()` must materialize the full visible tree into the child, which violates the current O(1) fork tests.

Recommended decision for this proposal: keep the current no-DDL, O(1) fork model and document it as live CoW overlays. Add a separate future proposal for snapshot semantics if needed.

## Goals

- Make the promote-and-delete workflow expressible in the public API: create experimental version, edit, make it self-contained, swap labels, optionally delete the old label holder.
- Make versions usable as branches in the live-overlay model: compare visible views, apply changes from one version to another, report conflicts, and restore paths from another version.
- Keep the existing schema: `fs_versions`, `version_ancestors`, `fs_entries`, `fs_blobs`.
- Preserve workspace isolation through RLS and `SET LOCAL app.workspace_id`.
- Keep source versions read-only during operations. Only the current destination version should receive new `fs_entries` rows or tombstones.
- Keep implementation adapter-neutral. All SQL must continue to flow through `SqlClient.query(text, params)`.

## Non-goals

- Three-way content merging for text, JSON, or binary files. The API reports path-level conflicts and lets callers resolve file contents.
- Distributed replication or cross-database version movement.
- Per-path ACLs.
- A new schema migration for immutable snapshot history.
- Rewriting the public filesystem API away from `just-bash` compatibility.

## Core invariants

- Visibility invariant: for a version `V` and path `P`, the visible row is the row for `P` from the nearest ancestor of `V` ordered by `version_ancestors.depth ASC`; if that row is `tombstone`, `P` is not visible.
- Write invariant: writes to a `PgFileSystem` instance only write rows for that instance's current version ID.
- Workspace invariant: all SQL runs inside a transaction with `app.workspace_id` set to the instance workspace and `statement_timeout` set from options.
- Blob invariant: `fs_blobs` are workspace-scoped and content-addressed by hash. Version operations should copy `blob_hash` references, not duplicate blob rows.
- Tree invariant: directory operations must not create visible children under a missing parent. Batch operations that copy files must also copy or ensure needed parent directories.
- Delete invariant: deleting a version must not change the visible view of any remaining version.
- Label invariant: labels are unique per workspace; IDs are stable. Operations that swap or rename labels should operate internally by ID after labels are resolved.
- Root invariant: public path options are user paths under `rootDir`; SQL uses internal normalized paths converted to `ltree`; public results convert back to user paths.

## Shared implementation building blocks

Implement these before the individual primitives. They keep SQL and edge-case behavior consistent.

### Public types

Add versioning types to `lib/core/types.ts` and export them from `lib/core/index.ts`.

```ts
export type NodeType = "file" | "directory" | "symlink";

export interface EntryShape {
  type: NodeType;
  mode: number;
  size: number;
  mtime: Date;
  blobHash: string | null;
  symlinkTarget: string | null;
}

export interface VersionDiffEntry {
  path: string;
  change: "added" | "removed" | "modified" | "type-changed";
  before: EntryShape | null;
  after: EntryShape | null;
}

export type MergeStrategy = "fail" | "ours" | "theirs";

export interface ConflictEntry {
  path: string;
  base: EntryShape | null;
  ours: EntryShape | null;
  theirs: EntryShape | null;
}

export interface MergeResult {
  applied: string[];
  conflicts: ConflictEntry[];
  skipped: string[];
}

export interface RenameVersionResult {
  label: string;
  displacedLabel?: string;
}

export interface PromoteResult {
  label: string;
  displacedLabel?: string;
  droppedPrevious: boolean;
}
```

Public `blobHash` should be a hex string, not `Uint8Array`, because it is stable across drivers and safe to serialize.

Internally, keep a private row type that contains raw `Uint8Array | null` for writing `fs_entries.blob_hash` back to PostgreSQL.

### Instance state refactor

`renameVersion()` needs to change the instance's label after a successful commit. The current `readonly version: string` prevents that.

Recommended minimal refactor:

```ts
private versionLabel: string;

get version(): string {
  return this.versionLabel;
}
```

Then replace internal reads of `this.version` that are expected to mutate with `this.versionLabel`. External callers still read `fs.version`; they do not get a public setter.

When only a label changes, keep `cachedVersionId` because the underlying version ID did not change. When an operation creates or switches to a different version ID, update or clear `cachedVersionId` explicitly.

### Transaction-aware facade

Most primitives need to compose multiple existing filesystem operations atomically. Add a transaction-aware facade rather than duplicating public methods.

Recommended shape:

- Split `withWorkspace()` into a lower-level `runInWorkspace(client, fn)` that can use either the normal client or an already-open transaction client.
- Add a private constructor option or private factory for a transaction-bound `PgFileSystem` facade.
- The transaction facade has the same public surface as `PgFileSystem`, but its methods run against the already-open `SqlClient` transaction instead of opening a top-level transaction.
- Keep nested calls safe. Current postgres.js and node-postgres adapters support nested transactions through savepoints. Drizzle delegates to `db.transaction()`, so verify nested transaction behavior with the Drizzle adapter before relying on savepoints there.
- Queue post-commit instance mutations, such as updating the outer instance label after `renameVersion()`. Apply them only after the outer transaction resolves successfully.

### Version lookup helpers

Add private helpers in `filesystem.ts`.

```ts
private async getVersionIdByLabel(tx: SqlClient, label: string): Promise<number | null>
private async requireVersionIdByLabel(tx: SqlClient, label: string): Promise<number>
private async getCurrentVersionId(tx: SqlClient): Promise<number>
private async ensureVersion(tx: SqlClient): Promise<number>
```

`getCurrentVersionId()` and `ensureVersion()` already exist; keep their current behavior but make label access go through `versionLabel`.

### Visibility CTE helper

Use one canonical visible-entry SQL shape everywhere. Today the same pattern appears in `resolveEntry()`, `listVisibleChildren()`, `listVisibleSubtree()`, `glob()`, and `search.ts`.

Canonical fields:

```sql
SELECT DISTINCT ON (e.path)
  e.path::text AS path,
  e.blob_hash,
  e.node_type,
  e.symlink_target,
  e.mode,
  e.size_bytes,
  e.mtime,
  e.version_id
FROM fs_entries e
JOIN version_ancestors a
  ON a.workspace_id = e.workspace_id
 AND a.ancestor_id = e.version_id
WHERE e.workspace_id = $workspace
  AND a.descendant_id = $versionId
  AND e.path <@ $scope::ltree
ORDER BY e.path, a.depth ASC
```

Then filter `node_type != 'tombstone'` at the outer query when the operation wants visible paths. Keep tombstone rows during intermediate classification only when the operation needs to know which version owns a deletion.

### Entry equality

Path-level equality for diff and merge should compare:

- `node_type`
- `blob_hash`
- `mode`
- `symlink_target`

Do not compare `mtime`, `created_at`, or `size_bytes` for equality. `size_bytes` is derived from content or symlink target and is useful in output, but `blob_hash` and `symlink_target` are the semantic fields.

### Entry writing helper

Add a private helper that can apply an already-existing entry shape to the current version without re-reading or re-hashing content.

```ts
private async writeEntryShape(
  tx: SqlClient,
  versionId: number,
  internalPath: string,
  entry: InternalEntryShape | null,
): Promise<void>
```

Behavior:

- If `entry === null`, write a tombstone for `internalPath`.
- If `entry.type === "file"`, copy the `blob_hash`, `mode`, and `size_bytes` into a current-version `fs_entries` row. Do not insert a blob row because source and destination are in the same workspace, so the blob already exists.
- If `entry.type === "directory"`, upsert a directory row.
- If `entry.type === "symlink"`, upsert a symlink row with `symlink_target`, `mode`, and `size_bytes`.
- Stamp `mtime = now()` for applied merge/cherry-pick/revert writes. This records when the destination version adopted the entry.
- Preserve `created_at` default behavior.

For batch apply, sort writes so directories are created before their children and tombstones for subtree removals are written deepest-first when that avoids transient parent/child inconsistencies.

### Parent-directory expansion

`merge()`, `cherryPick()`, and `revert()` can copy a file whose parent directory does not exist in the current version. Before applying a non-null file or symlink entry, ensure all parent directories visible in the source/target are also applied or already visible in the destination.

Implementation path:

- Build the apply set.
- For every non-null file or symlink apply, walk parent paths up to `/`.
- If a parent is not visible in destination after the planned apply set, copy that parent directory shape from the same source view.
- If the source parent is missing or is not a directory, treat this as source corruption and throw.

### Node-count validation

Existing single-path writes call `validateNodeCount()` when creating a new visible node. Batch operations must enforce `maxFiles` too.

Recommended approach:

- During classification, compute `currentVisibleCount`.
- Compute net new visible paths after applying the planned changes.
- If the result exceeds `maxFiles`, throw before writing.

This avoids running `validateNodeCount()` once per path in large merges.

### Locking discipline

Graph rewrites and bulk applies need stronger serialization than the current public methods provide.

Recommended no-DDL locking path:

- Add a private advisory-lock helper for version mutation.
- Use it in every method that writes `fs_entries` or `fs_versions`.
- Graph operations should lock affected version IDs in sorted order to avoid deadlocks.
- Keep the existing `SELECT ... FOR UPDATE` row locks on `fs_versions` for graph mutations.

Minimum lock coverage by primitive:

- `detach()`: lock current version, descendants in its subtree, and the workspace/version advisory locks for those IDs.
- `renameVersion()`: lock current version and displaced version if one exists.
- `promoteTo()`: lock current version, descendants, and displaced version.
- `merge()`, `cherryPick()`, `revert()`: lock current destination version; source versions are read-only and do not need mutation locks.
- `deleteVersion()`: keep the existing lock and also align it with the shared helper.

This is more than the original proposal, but it is necessary because `detach()` deletes current-version tombstones and rewrites closure rows; concurrent writes to the same version could otherwise be lost.

## Primitive 1: `transaction(fn)`

```ts
async transaction<T>(fn: (tx: PgFileSystemTx) => Promise<T>): Promise<T>
```

### Purpose

Expose the same transaction boundary that `PgFileSystem` already uses internally, so callers and higher-level primitives can compose multiple operations atomically.

Without this primitive, workflows such as `detach() + renameVersion() + deleteVersion()` can fail halfway and leave a branch promoted but not cleaned up, or cleaned up but not promoted.

### API contract

- `fn` receives a transaction-bound filesystem facade for the same workspace, rootDir, version, permissions, limits, embedding provider, and statement timeout.
- All operations inside `fn` run in one database transaction.
- If `fn` throws, all writes from the transaction roll back.
- If `fn` returns, the transaction commits and its return value is returned.
- The transaction facade should be usable anywhere a `PgFileSystem` is expected, except callers should not store it after `fn` returns.
- Read-only instances still use the readonly SQL wrapper; writes inside the transaction fail with `EPERM`/SQL read-only errors as they do today.

### Implementation path

1. Introduce `PgFileSystemTx` as a type alias or interface for the public filesystem surface. The minimal first version can be `PgFileSystem` itself if the facade is an instance of the same class.
2. Refactor `withWorkspace()` into two layers:

```ts
private runInWorkspace<T>(client: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T>
private withWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>
```

3. Add a private transaction-bound mode to `PgFileSystem` so methods can call `runInWorkspace(existingTx, fn)` instead of `this.client.transaction(...)`.
4. Cache the current version ID once for the facade. The facade can start with the parent instance's `cachedVersionId` when present.
5. Support post-commit hooks for label mutation. This avoids changing the outer instance if the transaction rolls back.
6. Add tests that a successful transaction commits two writes and a thrown error rolls both back.
7. Add tests that `renameVersion()` inside a transaction updates the outer instance label only after commit.

### Acceptance tests

- Two `writeFile()` calls inside `transaction()` are both visible after commit.
- A `writeFile()` followed by a thrown error leaves no file behind.
- A nested public method call inside `transaction()` does not open an independent transaction that commits early.
- A readonly filesystem transaction rejects writes.
- `statement_timeout` and RLS workspace isolation still apply inside the transaction.

## Primitive 2: `diff(other, opts?)` and `diffStream(other, opts?)`

```ts
async diff(other: string, opts?: { path?: string }): Promise<VersionDiffEntry[]>

async *diffStream(
  other: string,
  opts?: { path?: string; batchSize?: number },
): AsyncIterable<VersionDiffEntry>
```

### Purpose

Compare the current version's visible tree to another version's visible tree. This is the read-side primitive that powers review UIs, merge previews, promote checks, and agent change summaries.

### API contract

- `other` is a version label in the same workspace.
- No ancestor relationship is required.
- `opts.path` scopes the comparison to a user path and its descendants. For `/dir`, include `/dir` and everything under it.
- Results are sorted by path for deterministic output.
- Paths in results are user paths under the instance `rootDir`.
- `before` is the current version's entry and `after` is `other`'s entry. This means `fs.diff("branch")` answers "what would change if current became branch?".

### Change classification

- `added`: current has no visible entry, other has a visible entry.
- `removed`: current has a visible entry, other has no visible entry.
- `modified`: both have visible entries with the same node type but different equality fields.
- `type-changed`: both have visible entries with different node types.
- Equal entries are omitted.

### SQL shape

Use two visible CTEs and a `FULL OUTER JOIN`.

```sql
WITH ours AS (
  SELECT * FROM visible_entries($current, $scope)
  WHERE node_type != 'tombstone'
),
theirs AS (
  SELECT * FROM visible_entries($other, $scope)
  WHERE node_type != 'tombstone'
)
SELECT
  COALESCE(ours.path, theirs.path) AS path,
  ours.node_type AS before_type,
  ours.blob_hash AS before_blob_hash,
  ours.mode AS before_mode,
  ours.symlink_target AS before_symlink_target,
  ours.size_bytes AS before_size_bytes,
  ours.mtime AS before_mtime,
  theirs.node_type AS after_type,
  theirs.blob_hash AS after_blob_hash,
  theirs.mode AS after_mode,
  theirs.symlink_target AS after_symlink_target,
  theirs.size_bytes AS after_size_bytes,
  theirs.mtime AS after_mtime
FROM ours
FULL OUTER JOIN theirs USING (path)
WHERE ours.path IS NULL
   OR theirs.path IS NULL
   OR ours.node_type != theirs.node_type
   OR ours.mode != theirs.mode
   OR ours.symlink_target IS DISTINCT FROM theirs.symlink_target
   OR ours.blob_hash IS DISTINCT FROM theirs.blob_hash
ORDER BY path
```

In code, do not literally create a SQL function unless we want DDL. Inline the visible CTE.

### `diffStream()` implementation

`SqlClient` does not expose cursors, so implement streaming as keyset pagination.

- Default `batchSize` to a conservative value such as `500`.
- Clamp `batchSize` to a max such as `5000`.
- Add `WHERE path > $lastPath` around the joined result.
- Yield rows until a batch returns fewer than `batchSize`.

This avoids loading a large diff into memory while staying adapter-neutral.

### Edge cases

- A tombstone in either version should appear as `null` for that side.
- A file-to-symlink change is `type-changed`.
- A symlink target change is `modified`.
- A mode-only change is `modified`.
- `mtime` differences alone do not produce a diff entry.
- `opts.path` must pass through `guardRead()` and `toInternalPath()`.

### Acceptance tests

- Added, removed, modified, type-changed, mode-only, and symlink-target diffs.
- Diff between sibling versions with no direct ancestor requirement.
- Diff scoped to a subtree.
- Diff under a non-root `rootDir` returns user paths.
- `diffStream()` returns the same rows as `diff()` across multiple batches.

## Primitive 3: `detach()`

```ts
async detach(): Promise<void>
```

### Purpose

Make the current version self-owning. After `detach()`, the current version no longer depends on former ancestors for any path it can currently see. This is the missing step that makes "promote experimental, then delete old main" safe.

### API contract

- Operates on the current version.
- Does not change the current version label.
- Does not change visible contents of the current version.
- Does not change visible contents of descendants of the current version.
- Does not write rows for unrelated versions.
- After success, the current version has `parent_version_id = NULL`.
- Former ancestors can be deleted if no other direct children still reference them.

### Descendant-safe graph behavior

The simple version of detach only rewrites the current version's closure rows. That is not enough if the current version has descendants.

Reason: `detach()` materializes visible entries into the current version and then deletes current-version tombstones as redundant. Those tombstones are only redundant if descendants no longer see former ancestors directly. Otherwise a descendant could start seeing a file from a former ancestor that the current version had tombstoned.

Therefore `detach()` must update closure rows for the entire subtree rooted at the current version:

- Keep closure rows among versions inside the subtree.
- Remove closure rows from subtree descendants to ancestors outside the subtree.
- Leave direct child `parent_version_id` values pointing to the current version.
- Set only the current version's `parent_version_id` to `NULL`.

### Implementation path

All steps run in one transaction.

1. Resolve current version ID `V`.
2. Find the subtree rooted at `V`:

```sql
SELECT descendant_id
FROM version_ancestors
WHERE workspace_id = $1 AND ancestor_id = $2
ORDER BY descendant_id
```

3. Lock the subtree version rows in deterministic order:

```sql
SELECT id
FROM fs_versions
WHERE workspace_id = $1 AND id = ANY($2)
ORDER BY id
FOR UPDATE
```

4. Acquire advisory mutation locks for the same version IDs in the same sorted order.
5. Materialize inherited visible entries into `V` before rewriting closure rows:

```sql
INSERT INTO fs_entries (
  workspace_id,
  version_id,
  path,
  blob_hash,
  node_type,
  symlink_target,
  mode,
  size_bytes,
  mtime,
  created_at
)
SELECT
  $1,
  $2,
  src.path,
  src.blob_hash,
  src.node_type,
  src.symlink_target,
  src.mode,
  src.size_bytes,
  src.mtime,
  now()
FROM (
  SELECT DISTINCT ON (e.path) e.*
  FROM fs_entries e
  JOIN version_ancestors a
    ON a.workspace_id = e.workspace_id
   AND a.ancestor_id = e.version_id
  WHERE e.workspace_id = $1
    AND a.descendant_id = $2
  ORDER BY e.path, a.depth ASC
) src
WHERE src.version_id <> $2
  AND src.node_type <> 'tombstone'
ON CONFLICT (workspace_id, version_id, path) DO NOTHING
```

Tombstones at depth `0` win in the `DISTINCT ON`; the outer `src.node_type <> 'tombstone'` filter prevents a hidden inherited row from being materialized.

6. Detach the current version row:

```sql
UPDATE fs_versions
SET parent_version_id = NULL
WHERE workspace_id = $1 AND id = $2
```

7. Remove closure links from the subtree to former ancestors outside the subtree:

```sql
DELETE FROM version_ancestors
WHERE workspace_id = $1
  AND descendant_id = ANY($2)
  AND NOT (ancestor_id = ANY($2))
```

This preserves self rows and descendant-to-ancestor rows within the subtree.

8. Delete current-version tombstones:

```sql
DELETE FROM fs_entries
WHERE workspace_id = $1
  AND version_id = $2
  AND node_type = 'tombstone'
```

9. Leave blobs alone. Materialized entries reference existing blobs. Deleted tombstones do not reference blobs.

### Cost

`detach()` is O(visible paths at current version + versions in current subtree). It should honor `statementTimeoutMs` and fail loudly if the branch is too large to detach under the configured timeout.

### Acceptance tests

- Current version visible contents before and after detach are byte-for-byte identical.
- Descendant visible contents before and after detach are byte-for-byte identical.
- A current-version tombstone remains semantically effective for descendants after detach, even though the tombstone row is removed.
- `listVersions()` is unchanged.
- `parent_version_id` for current becomes `NULL`.
- Closure rows from current subtree to former ancestors are removed.
- Former ancestor deletion succeeds when no other direct child references it.
- Blob rows referenced by current visible files remain present.
- `detach()` on an already-root version is idempotent and preserves contents.

## Primitive 4: `renameVersion(newLabel, opts?)`

```ts
async renameVersion(
  newLabel: string,
  opts?: { swap?: boolean },
): Promise<RenameVersionResult>
```

### Purpose

Rename the current version label. With `swap: true`, atomically move an existing label out of the way and give the current version that label. This is the label half of branch promotion.

### API contract

- `newLabel` must be non-empty.
- If `newLabel` is already the current version's label, return `{ label: newLabel }` and do nothing.
- If `newLabel` exists and `swap` is not true, throw a clear duplicate-label error.
- If `swap: true` and `newLabel` exists on another version, rename the displaced version to a generated previous label and return it as `displacedLabel`.
- Update the calling instance's `version` after commit.
- Keep `cachedVersionId`; the current version ID does not change.

Returning `displacedLabel` is a recommended adjustment to the original `Promise<void>` shape. Without it, callers cannot reliably delete or inspect the previous label holder because the generated temp label is not known.

### Previous-label format

Use a deterministic, collision-resistant format:

```txt
<newLabel>-prev-<YYYYMMDDHHMMSS>-<displacedId>
```

If the generated label somehow exists, append a short counter in the same transaction.

### Implementation path

1. Resolve and lock current version `V`.
2. Query the target label row with `FOR UPDATE`:

```sql
SELECT id, label
FROM fs_versions
WHERE workspace_id = $1 AND label = $2
FOR UPDATE
```

3. If no target row exists, update current:

```sql
UPDATE fs_versions
SET label = $3
WHERE workspace_id = $1 AND id = $2
```

4. If target row is current `V`, no-op.
5. If target row exists and `swap !== true`, throw duplicate-label error. Map SQL unique violations (`23505`, `unique_workspace_version_label`) to the same public message if an insert/update race occurs.
6. If `swap: true`, update displaced version to the generated previous label, then update current to `newLabel`:

```sql
UPDATE fs_versions
SET label = $3
WHERE workspace_id = $1 AND id = $2
```

Run this first for displaced ID, then for current ID.

7. After commit, update `versionLabel` on the instance and any transaction facade that needs to keep operating under the new label.

### Stale instances

Other `PgFileSystem` instances that were constructed with the old label or displaced label can become stale because they may have a cached version ID but a label that no longer exists or now points elsewhere.

Document this explicitly:

- The instance that performs `renameVersion()` is updated.
- Other instances should be reconstructed after label swaps if they address versions by label.
- Cached IDs continue to point to the original version ID for existing instances, so reads/writes may still affect that ID even if the public label has moved. This is consistent with the current sticky `cachedVersionId` behavior but must be called out.

### Acceptance tests

- Rename to an unused label updates `fs.version` after commit.
- Rename to an existing label without `swap` throws.
- Rename to an existing label with `swap` moves the old holder to `displacedLabel`.
- `listVersions()` contains the new label and displaced label.
- The version ID for the calling instance is unchanged.
- A rollback leaves the instance label unchanged.

## Sugar: `promoteTo(label, opts?)`

```ts
async promoteTo(
  label: string,
  opts?: { dropPrevious?: boolean },
): Promise<PromoteResult>
```

### Purpose

Provide the one-call promote workflow:

1. Make current version self-owning.
2. Move the destination label to the current version.
3. Optionally delete the previous label holder.

### API contract

- Runs atomically in one transaction.
- Calls `detach()` first.
- Calls `renameVersion(label, { swap: true })` second.
- If `dropPrevious` is true and a previous holder existed, deletes that displaced version in the same transaction.
- If deleting the displaced version fails because it still has descendants, the whole promotion rolls back.
- Returns the final label, displaced label if kept or attempted, and whether the previous holder was dropped.

### Implementation path

Implement `promoteTo()` after `detach()` and `renameVersion()` exist. Internally, use the same private inner helpers as those public methods so `promoteTo()` does not create nested transactions for its own steps.

Pseudo-flow:

```ts
return this.transaction(async (tx) => {
  await tx.detach();
  const renamed = await tx.renameVersion(label, { swap: true });
  if (opts?.dropPrevious && renamed.displacedLabel) {
    await tx.deleteVersion(renamed.displacedLabel);
  }
  return {
    label,
    displacedLabel: opts?.dropPrevious ? undefined : renamed.displacedLabel,
    droppedPrevious: Boolean(opts?.dropPrevious && renamed.displacedLabel),
  };
});
```

The actual implementation should call private inner helpers to avoid facade recursion if that is cleaner.

### Acceptance tests

- Promote experimental to `main` and keep previous `main` under a generated label.
- Promote experimental to `main` with `dropPrevious: true` deletes old `main`.
- Promotion rollback preserves old labels if deleting previous fails.
- Promoted version can still read every file it had before promotion after old `main` is deleted.
- Descendants of the promoted version keep their visible contents.

## Primitive 5: `merge(source, opts?)`

```ts
async merge(
  source: string,
  opts?: {
    strategy?: MergeStrategy;
    paths?: string[];
    pathScope?: string;
    dryRun?: boolean;
  },
): Promise<MergeResult>
```

### Purpose

Apply path-level changes from a source version into the current version using a three-way comparison against the nearest common ancestor. Report conflicts instead of attempting content-level merges.

### API contract

- `source` is a version label in the same workspace.
- Destination is the current version.
- Source and base are read-only.
- Only destination receives `fs_entries` writes.
- `strategy` defaults to `"fail"`.
- `dryRun: true` computes and returns the result without writes.
- `paths` limits the operation to exact user paths. Directory paths expand to their visible subtree.
- `pathScope` limits the operation to one subtree.
- Supplying both `paths` and `pathScope` means use their intersection.
- `merge()` does not change `parent_version_id` or closure rows.

### LCA query

```sql
SELECT a1.ancestor_id
FROM version_ancestors a1
JOIN version_ancestors a2
  ON a2.workspace_id = a1.workspace_id
 AND a2.ancestor_id = a1.ancestor_id
WHERE a1.workspace_id = $1
  AND a1.descendant_id = $2
  AND a2.descendant_id = $3
ORDER BY a1.depth + a2.depth ASC
LIMIT 1
```

If no LCA exists, treat base as an empty tree.

Fast path: if `source` is the LCA, source is already an ancestor of current. Current already includes source through live ancestor visibility, so return no applied paths and no conflicts.

### Classification table

Equality uses `node_type`, `blob_hash`, `mode`, and `symlink_target`.

| base | ours | theirs | default action |
| ---- | ---- | ------ | -------------- |
| X | X | X | skipped if all equal |
| X | X | Y | apply theirs |
| X | Y | X | skipped, keep ours |
| X | Y | Z | conflict |
| - | - | X | apply theirs |
| - | X | - | skipped, keep ours |
| X | - | - | skipped, both deleted |
| X | - | X | skipped, keep ours deletion |
| X | X | - | apply deletion |
| X | - | Y | conflict, delete-vs-modify |
| - | X | Y | conflict if X and Y differ; skipped if equal |

For conflicts:

- `strategy: "fail"`: return conflicts and do not write anything.
- `strategy: "ours"`: keep destination value, include the path in `conflicts` for visibility, include it in `skipped`, and do not write.
- `strategy: "theirs"`: apply source value and include path in `applied`; include conflict details in `conflicts` so callers know an override happened.

### SQL/data flow

1. Resolve destination, source, and LCA IDs.
2. Build candidate paths as the union of visible paths in base, ours, and theirs after applying `paths` and `pathScope` filters.
3. Fetch base/ours/theirs entry shapes for each candidate path.
4. Classify in TypeScript. This keeps the conflict table readable and testable.
5. If conflicts exist and strategy is `"fail"`, return without writes.
6. Expand apply set with needed parent directories.
7. Validate resulting node count against `maxFiles`.
8. If `dryRun`, return without writes.
9. Lock destination version for mutation.
10. Apply entries and tombstones to destination.

### Path filters

`paths` and `pathScope` must use user paths at the API boundary.

Implementation rules:

- Normalize every user path.
- Use `guardRead()` for source-side filters and `guardWrite()` for destination writes.
- Convert filters to internal paths before `pathToLtree()`.
- For an exact file path in `paths`, include that path.
- For a directory path in `paths`, include that directory and descendants visible in any of base/ours/theirs.

### Applying deletions

Deletion means writing tombstones in destination.

For directory deletions, tombstone every visible descendant path in the candidate set, not only the directory path. The current filesystem's recursive `rm` already uses this model because visibility is per-path; tombstoning only a parent directory would not hide inherited child paths.

### Acceptance tests

- Clean merge applies a source-only added file.
- Clean merge applies a source modification when ours equals base.
- Clean merge applies source deletion when ours equals base.
- Ours-only change is skipped.
- Both sides make the same change and it is skipped.
- Both sides modify differently and `strategy: "fail"` reports conflict with no writes.
- `strategy: "ours"` leaves destination unchanged and reports conflict.
- `strategy: "theirs"` overwrites destination and reports conflict.
- Delete-vs-modify conflict is reported.
- Directory deletion tombstones the whole subtree.
- `dryRun` produces the same result without changing destination.
- `paths` and `pathScope` limit the merge.
- Merging an ancestor source into current is a no-op.

## Primitive 6: `cherryPick(source, paths)`

```ts
async cherryPick(source: string, paths: string[]): Promise<MergeResult>
```

### Purpose

Copy selected visible paths from another version into the current version without using LCA conflict semantics. This supports "bring this file or subtree from another agent branch" workflows.

### API contract

- `source` is a version label in the same workspace.
- `paths` must be non-empty.
- Each path is a user path.
- If a selected path is a directory in source or destination, operate on the whole subtree.
- If a path exists in destination but not source, write tombstones for that path or subtree.
- If source and destination are equal at a path, include it in `skipped`.
- `conflicts` is always empty because cherry-pick is explicitly source-wins for selected paths.

### Relationship to `merge()`

This is not exactly `merge(source, { paths, strategy: "theirs" })`, because `merge()` uses LCA classification and reports conflicts. `cherryPick()` should use the same lower-level apply machinery but a simpler two-way comparison:

- Fetch current visible shape.
- Fetch source visible shape.
- If equal, skip.
- Otherwise apply source shape, or tombstone if source is absent.

### Implementation path

1. Resolve source and current IDs.
2. Expand selected paths to exact path/subtree candidate sets.
3. Fetch current and source visible shapes.
4. Build source-wins apply set.
5. Expand parent directories for copied files/symlinks.
6. Validate node count.
7. Apply writes in one transaction.
8. Return `MergeResult` with `conflicts: []`.

### Acceptance tests

- Cherry-pick one file from source into current.
- Cherry-pick one directory copies descendants.
- Cherry-pick a missing source path deletes the destination path.
- Cherry-pick creates missing parent directories from source.
- Equal selected paths are skipped.
- Empty `paths` throws.

## Primitive 7: `revert(target, opts?)`

```ts
async revert(
  target: string,
  opts?: { paths?: string[]; pathScope?: string },
): Promise<void>
```

### Purpose

Restore the current version's selected visible tree to match another version. This is rollback-oriented and intentionally has no conflicts.

### API contract

- `target` is a version label in the same workspace.
- Destination is the current version.
- `paths` and `pathScope` use the same filter semantics as `merge()`.
- For every in-scope path visible in target, write target's entry shape to current.
- For every in-scope path visible in current but not target, write a tombstone.
- No LCA is used.
- No content merge is attempted.

### Snapshot warning

With the current live-overlay fork model, `await fs.fork("pre-merge")` is not a reliable rollback snapshot if `fs` is later modified, because the fork can still see parent changes. For a rollback checkpoint under the current schema, callers should either:

- Fork and immediately `detach()` the checkpoint version, or
- Wait for a separate materialized snapshot helper if one is added later.

### Implementation path

`revert()` can share most of `cherryPick()`'s two-way apply machinery, but its path universe is target union current for the selected scope.

1. Resolve target and current IDs.
2. Build candidate paths from visible current and visible target, filtered by `paths`/`pathScope`.
3. For each path, compare current and target.
4. Apply target shape, or tombstone if target is absent.
5. Expand parent directories for copied files/symlinks.
6. Validate node count.
7. Apply writes in one transaction.

### Acceptance tests

- Revert one modified file to target content.
- Revert deletes a file that does not exist in target.
- Revert restores a deleted file that exists in target.
- Revert directory scope restores and deletes descendants as needed.
- Revert creates missing parent directories.
- Revert under non-root `rootDir` respects user paths.

## End-to-end promoted branch workflow

```ts
const main = new PgFileSystem({ db, workspaceId, version: "main" });
await main.init();

const exp = await main.fork("exp-2026-04-28");
await exp.writeFile("/config.json", '{"env":"prod"}');

const result = await exp.promoteTo("main", { dropPrevious: true });

console.log(result.label); // "main"
```

Equivalent explicit form:

```ts
const result = await exp.transaction(async (tx) => {
  await tx.detach();
  const renamed = await tx.renameVersion("main", { swap: true });
  if (renamed.displacedLabel) {
    await tx.deleteVersion(renamed.displacedLabel);
  }
  return renamed;
});
```

## Implementation order

### Phase 0: Pin semantics and tests for current behavior

- Add tests that document live overlay behavior for parent writes after fork.
- Decide explicitly whether to keep O(1) fork live overlays for this proposal.
- Update README wording if needed; it currently describes fork as copying rows even though tests enforce O(1) fork.

### Phase 1: Shared refactor

- Add public versioning types.
- Refactor `version` into a getter backed by mutable private state.
- Add transaction-aware execution support.
- Add canonical visible-entry helpers and entry-shape mapping helpers.
- Add batch apply helper, parent-directory expansion, node-count validation, and entry equality.
- Add advisory lock helper and apply it to write paths and graph mutations.

### Phase 2: `transaction()`

- Implement public `transaction(fn)`.
- Test commit, rollback, readonly, nested calls, and post-commit label mutation.

### Phase 3: `diff()` and `diffStream()`

- Implement read-only comparison.
- Test all change kinds, scope filters, rootDir, and streamed pagination.

### Phase 4: `detach()`

- Implement descendant-safe materialization and closure rewrite.
- Test current and descendant views before/after.
- Test deletion of former ancestors after detach.

### Phase 5: `renameVersion()` and `promoteTo()`

- Implement label rename, swap, result object, and instance-state updates.
- Implement atomic promote sugar.
- Test rollback behavior and stale-instance documentation examples.

### Phase 6: `merge()`

- Implement LCA query, classification, dry-run, conflict strategies, subtree deletion, and apply helper reuse.
- Test full conflict matrix.

### Phase 7: `cherryPick()` and `revert()`

- Implement two-way source-wins apply.
- Implement rollback-oriented restore.
- Test parent-directory creation and subtree behavior.

## Open questions before coding

- Do we accept live-overlay fork semantics as the documented model for this release? If not, the no-DDL/O(1) constraint must change.
- Should `renameVersion()` and `promoteTo()` return result objects as proposed, or preserve `Promise<void>` and expose displaced labels another way?
- Should `strategy: "ours"` include overridden conflicts in `conflicts`, or should it treat them as skipped? This plan keeps them in `conflicts` for transparency.
- Should `diff()` direction be current-to-other as proposed, or should `before` mean `other` and `after` mean current? Pick one and document it prominently.
- Should advisory locks be added to all existing write methods in the same release, or only to new graph/batch primitives? Full correctness for concurrent `detach()` requires all write methods.
- What is the maximum supported batch size for `diffStream()` and merge apply before callers should use a higher statement timeout?
- Should `revert()` return a `MergeResult`-like summary for observability, even though it has no conflicts? The original proposal returns `void`; an applied/skipped summary may be more useful.

## Verification checklist

- `npm run typecheck`
- `npm test`
- Targeted versioning tests across all adapters in `TEST_ADAPTERS`
- New tests in `tests/versioning.test.ts` for public API behavior
- New tests in `tests/cow.test.ts` for CoW invariants, detach materialization, closure rewrites, and blob GC
- Manual SQL assertions for `fs_versions.parent_version_id` and `version_ancestors` rows after `detach()` and `promoteTo()`
