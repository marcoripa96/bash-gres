# Follow-up notes

Open work items deferred from prior changes. Each entry records the
trigger, what was done in the original change, and the proposed next step.

## Exclude: dedicated `basename` column for fast leaf-glob

**Trigger.** `PgFileSystem({ exclude: [...] })` (see `lib/core/exclude.ts`).
The hybrid pushdown compiles three buckets per instance:

1. `lqueries` (label-name patterns) — `path ~ ANY(...::lquery[])`, GiST-indexed.
2. `prefixes` (anchored subtrees) — `path <@ ANY(...::ltree[])`, GiST-indexed.
3. `regexes` (intra-label glob like `*.log`, `Dockerfile.*`) —
   `path::text ~ regex`, **not indexed**.

Bucket (3) currently runs as a sequential scan within the result set already
narrowed by `workspace_id`, `version_id`, `path <@ scope`, and other ltree
operators. On typical workspaces (≤10k visible nodes, exclusion applied at
a subtree, regex scanning a few hundred candidates) this is in the
millisecond range. The unbounded case is `walk('/')` over a very large
workspace with `*.ext`-style patterns and no other narrowing.

**Followup.** When that case becomes hot, add a dedicated indexed leaf-name
column instead of the regex-on-`path::text` fallback:

- Add `fs_entries.basename text NOT NULL`. Populate from the trailing label
  via a generated column or maintained on insert/update (`encodeLabel`
  inverse of the last segment, or store the *user-facing* basename directly
  if we don't want the SQL side to know about the encoding).
- Add `CREATE INDEX fs_entries_basename_trgm ON fs_entries USING gin
  (basename gin_trgm_ops)` (extension `pg_trgm`).
- In `lib/core/exclude.ts`, replace bucket (3) with
  `basename LIKE ANY($n::text[])` (or a regex with `~`), which the trigram
  index supports for both prefix and infix matches.

Migration is forward-only: `setup()` already idempotently creates schema,
so the new column + index can be added there with a one-shot backfill
(`UPDATE fs_entries SET basename = ... WHERE basename IS NULL`).

**Why we didn't do it now.** The schema change requires a backfill across
every existing workspace; the regex fallback is good enough at current
scale. Revisit when:

- A user reports `*.ext` slowness on `walk('/')` of a large workspace.
- A future feature wants leaf-glob at scale (e.g. server-side `find -name`).

## Exclude: gitignore semantics not implemented

The current pattern compiler is a *subset* of gitignore. Items deferred:

1. **Negation** (`!pattern`). gitignore evaluates patterns top-to-bottom and
   `!foo` re-includes a previously excluded path. Implementation requires
   tracking pattern order and producing a layered SQL clause (alternating
   `NOT` and `OR`). Not commonly used; deferred until requested.
2. **Trailing-slash dir-only enforcement**. `node_modules/` in gitignore
   matches *only* directories named `node_modules` (a regular file with
   that name is *not* excluded). The current compiler treats `name/` and
   `name` identically. To implement faithfully, we would need to OR in a
   `node_type = 'directory'` predicate for the leaf case while still
   matching descendants regardless. The corner case (a *file* named
   `node_modules`) is exotic enough to defer.
3. **Per-directory `.bashgresignore` files**. Like `.gitignore` per
   directory. Would need a runtime lookup at every readdir / walk, or a
   precomputed per-path exclusion set. Heavyweight; not requested.
