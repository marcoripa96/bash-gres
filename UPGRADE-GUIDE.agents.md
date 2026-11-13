# bash-gres Upgrade Guide (for coding agents)

Sections are newest first. Apply every section between the installed
version and the target, oldest first.

---

# 3.1 → 3.2

3.2 is additive: no API or default changes, no data backfill. It adds a
database migration (one column, one table, one trigger) and new opt-in APIs
(merge resolvers, text merge, unified diffs, freeze, materialize,
`compactHistory`, `versioned(path, { versionId })`).

## Step 1 — database migration (additive, idempotent)

3.2 adds:

- `fs_versions.frozen_at timestamptz` (nullable);
- the `fs_version_merges` table (merge parents) with RLS;
- the `fs_versions_frozen_guard` trigger, which refuses writes to frozen
  versions (it fires only on rows with `frozen_at` set).

Apply it:

- **Native**: re-run `setup(client, { ...the same options })` once.
- **Drizzle**, in this order:
  1. If your schema file destructures specific tables from `createSchema()`,
     add `fsVersionMerges` to the exports, otherwise `drizzle-kit generate`
     misses the table.
  2. Run `drizzle-kit generate`: it adds the `frozen_at` column and the
     `fs_version_merges` table.
  3. Paste the **entire** output of `generateMigrationSQL()` into a new
     custom migration (`drizzle-kit generate --custom`), ordered after the
     one from step 2. It now carries the trigger and the RLS policy for
     `fs_version_merges`; every statement is idempotent, so the statements
     already applied no-op.

bash-gres 3.1 keeps working against a migrated database. It cannot freeze
anything, and it is refused (`EPERM`) when it writes to a version that 3.2
froze.

## Step 2 — upgrade every process before using the new history APIs

`materialize()`, `promoteTo(..., { materialize: true })` and
`compactHistory()` trim the ancestor closure. 3.2 reads history and merge
bases from parent links, so nothing is lost, but 3.1 reads them from the
closure. A 3.1 process still running after a version is materialized sees
`listHistory()` end at that version, and its `merge()` picks an older base.
Roll out 3.2 everywhere first.

## Step 3 — optional: adopt the new APIs

Ask the user before changing behaviour. None of these are needed to upgrade.

- Publishing flows with `historyRetention: "retain"` can pass
  `promoteTo(label, { dropPrevious: true, freeze: true, materialize: true })`.
  This keeps the published version immutable and the closure linear.
- Roots built before 3.2 with long publish chains: run
  `await (await fs.versioned(root)).compactHistory()` once per root (or on
  the `/` handle). It removes nothing and keeps every version id readable.
  Do **not** use `sweepHistory()` for this: it deletes retained versions.
- `merge(source, { resolve: textMergeResolver })` merges non-overlapping
  line edits in the same file instead of reporting a conflict.

## Step 4 — verify

- Typecheck. `MergeResult` gained `resolved: string[]`, and
  `VersionHistoryEntry` gained `frozenAt` and `mergedFrom`. Only code that
  builds these objects by hand (test doubles) needs the new fields.
- Check that `SELECT frozen_at FROM fs_versions LIMIT 1` runs, and that
  `fs_version_merges` exists.

---

# 2.x → 3.0

This guide tells you, the agent, how to upgrade a host project from
**bash-gres 2.x to 3.0**. The release replaces file-level search with
chunk-granular search: two breaking API changes, one additive database
migration, and two one-time indexing passes. Existing filesystem data keeps
working untouched.

Follow the steps in order. Do not guess API shapes from memory — the
authoritative surface is `node_modules/bash-gres/README.md` ("Search"
section) and the shipped `.d.ts` files.

---

## Step 0 — REQUIRED: confirm scope with the user

Before changing code, ask (with your environment's structured question tool
if it has one, e.g. `AskUserQuestion`):

1. **"Does the project use search (`textSearch`/`semanticSearch`/`hybridSearch`)
   or embeddings (`embed` option)?"** If neither, the upgrade is just the
   dependency bump plus Step 3's additive migration — skip Steps 1, 2, 4.
2. **"Native `setup()` or Drizzle migrations?"** Decides how Step 3 is applied.

---

## Step 1 — breaking: searches are chunk-granular

`textSearch()` / `semanticSearch()` / `hybridSearch()` no longer return
file-level `SearchResult { path, name, rank, snippet? }`. They return
section-level:

```ts
interface ChunkSearchResult {
  path: string;
  startLine: number;   // 1-indexed, inclusive
  endLine: number;
  headingPath: string | null;  // "Title > Section"
  content: string;     // breadcrumb prefix + section body
  rank: number;
}
```

`hybridSearch`'s `textWeight`/`vectorWeight` options are gone (rankings are
fused with reciprocal-rank fusion). All three searches now take
`{ path?, limit?, perFileCap? }` (`perFileCap` default 3 hits per file).

Find every call site of the three methods and update the consumers:

- `.name` no longer exists — derive it from `path` if needed.
- `.snippet` no longer exists — the hit IS the snippet: use `.content`, or
  hydrate the exact section:

  ```ts
  const { content } = await fs.readFileLines(hit.path, {
    offset: hit.startLine,
    limit: hit.endLine - hit.startLine + 1,
  });
  ```

- Results may contain several hits per file (up to `perFileCap`) — dedupe by
  `path` only if the old file-level behavior is genuinely required.

## Step 2 — breaking: the embedder is batched

The `PgFileSystem` option changed shape:

```ts
// 2.x — one text per call
embed?: (text: string) => Promise<number[]>;
// 3.0 — a batch per call, one vector per input text, same order
embed?: (texts: string[]) => Promise<number[][]>;
```

Most embedding APIs accept arrays natively; update the wrapper (e.g. OpenAI:
`input: texts`, return `res.data.map((d) => d.embedding)`).
`embeddingDimensions` is unchanged. Embeddings are **no longer computed on
`writeFile`/`appendFile`** — indexing is the explicit pass in Step 4.

## Step 3 — database migration (additive, idempotent)

3.0 adds `fs_blob_chunks` (chunk index) and `fs_chunk_embeddings` (vector
cache). No existing tables change; older bash-gres versions keep working
against a migrated database.

- **Native**: re-run `setup(client, { ...the same options })` once — it is
  idempotent and creates only what is missing.
- **Drizzle**, in this order:
  1. If your schema file destructures specific tables from `createSchema()`,
     add `fsBlobChunks` (and `fsChunkEmbeddings` with vector search) to the
     exports first — otherwise `drizzle-kit generate` sees nothing new and
     emits an empty migration.
  2. Run `drizzle-kit generate` — this creates the table(s).
  3. Paste the **entire** output of `generateMigrationSQL()` into a new
     custom migration (`drizzle-kit generate --custom`), ordered after the
     table-creating one (its FK/RLS statements reference `fs_blob_chunks`).
     Every statement it emits is idempotent (`IF NOT EXISTS` / guarded `DO`
     blocks), so no diffing against your existing custom migrations — the
     already-applied statements no-op.

## Step 4 — enable chunking and index existing content

1. Add `chunking: true` to every `PgFileSystem` that writes or searches
   (`chunking: { volatileFrontmatterKeys: [...] }` if files carry volatile
   front-matter like fetch timestamps — keeps the embedding cache stable
   across re-crawls).
2. Run the passes once per workspace — both idempotent, both scoped to the
   handle's current version:

   ```ts
   await fs.backfillChunks();        // chunk blobs written before 3.0
   await fs.indexChunkEmbeddings();  // fill the vector cache (needs `embed`)
   ```

   Skip `indexChunkEmbeddings` if the project only uses `textSearch`.

Optional: give agent bash sessions search via the new `semgrep` command —
`createSemgrepCommand({ fs })` from `bash-gres/just-bash`, passed to
`new Bash({ fs, customCommands: [...] })`.

## Step 5 — verify

- Typecheck the project; fix every compile error at search call sites.
- Run one real query per search mode the project uses and check hits come
  back with `startLine`/`endLine` populated.
- If a search throws mentioning `fs_blob_chunks`, `fs_chunk_embeddings`, or
  `enableFullTextSearch`, Step 3 was incomplete — the error text names the
  missing setup flag or migration.
