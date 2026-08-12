import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";

function agentUpgradePrompt(): string {
  return `You are upgrading a host project from bash-gres 2.x to bash-gres 3.0.
The upgrade has two breaking API changes, one additive database migration,
and two one-time indexing passes. Work through the steps in order and verify
at the end. Read node_modules/bash-gres/README.md ("Search" section) whenever
you need the authoritative API surface.

## Breaking change 1 — searches are chunk-granular

textSearch() / semanticSearch() / hybridSearch() no longer return file-level
SearchResult { path, name, rank, snippet? }. They return section-level
ChunkSearchResult { path, startLine, endLine, headingPath, content, rank }.
hybridSearch's textWeight/vectorWeight options are gone (rankings are fused
with reciprocal-rank fusion); all three searches now take
{ path?, limit?, perFileCap? }.

Find every call site of the three search methods and update the consumers:
- ".name" no longer exists — derive it from path if needed.
- ".snippet" no longer exists — the hit IS the snippet: use .content, or
  hydrate the exact section with
  readFileLines(hit.path, { offset: hit.startLine,
                            limit: hit.endLine - hit.startLine + 1 }).
- Results may contain several hits per file (up to perFileCap, default 3) —
  dedupe by path only if the old file-level behavior is genuinely required.

## Breaking change 2 — the embedder is batched

The PgFileSystem option embed: (text: string) => Promise<number[]> is now
embed: (texts: string[]) => Promise<number[][]> — one vector per input text,
same order. Most embedding APIs accept arrays natively; update the wrapper.
embeddingDimensions is unchanged. Embeddings are NO LONGER computed on
writeFile/appendFile — indexing is an explicit pass (step 4).

## Step 3 — database migration (additive, idempotent)

New tables: fs_blob_chunks (chunk index) and fs_chunk_embeddings (vector
cache). No existing table changes; older rows keep working.
- Native setup() users: re-run setup(client, { ...same options }) once —
  it is idempotent and creates only what is missing.
- Drizzle users: the tables are in createSchema(); re-run
  drizzle-kit generate, and re-run generateMigrationSQL() for RLS.

## Step 4 — enable chunking and run the two passes once

1. Add chunking: true (or chunking: { volatileFrontmatterKeys: [...] } if
   files carry volatile front-matter like fetch timestamps) to every
   PgFileSystem that writes or searches.
2. Index pre-existing content once per workspace:
       await fs.backfillChunks()        // chunk blobs written before 3.0
       await fs.indexChunkEmbeddings()  // fill the vector cache (needs embed)
   Both are idempotent and version-scoped to the handle. Skip
   indexChunkEmbeddings if the project only uses textSearch.

## Step 5 — verify

- Typecheck the project; fix every compile error at search call sites.
- Run one real query per search mode the project uses and check hits come
  back with startLine/endLine populated.
- If searches throw with a message mentioning fs_blob_chunks,
  fs_chunk_embeddings, or enableFullTextSearch, step 3 was incomplete — the
  error text says exactly which setup flag or migration is missing.

Do not guess API shapes from memory: check node_modules/bash-gres/README.md
and the .d.ts files if anything here doesn't match the installed version.`;
}

export default function MigrationPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Migrating to 3.0
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          bash-gres 3.0 replaces file-level search with{" "}
          <a
            href="/docs/search"
            className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
          >
            chunk-granular search
          </a>
          : hits are sections with line ranges, vectors live in a
          content-addressed cache filled by an explicit pass, and the
          embedder is batched. The database migration is additive and
          idempotent — existing data keeps working.
        </p>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold tracking-tight">
            Agent Upgrade Prompt
          </h2>
          <CopyButton text={agentUpgradePrompt()} label="Copy prompt" />
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Upgrading with a coding agent? Copy this prompt — it is
          self-contained and walks the agent through the whole migration,
          including verification. Prefer the details yourself? They follow
          below.
        </p>
        <CodeBlock lang="markdown" code={agentUpgradePrompt()} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          What Breaks
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-medium text-foreground/80">2.x</th>
                <th className="py-2 font-medium text-foreground/80">3.0</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4">
                  Searches return file-level{" "}
                  <code className="font-mono">{`SearchResult { path, name, rank, snippet? }`}</code>
                </td>
                <td className="py-2">
                  Searches return section-level{" "}
                  <code className="font-mono">{`ChunkSearchResult { path, startLine, endLine, headingPath, content, rank }`}</code>
                </td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4">
                  <code className="font-mono">hybridSearch</code> takes{" "}
                  <code className="font-mono">textWeight</code> /{" "}
                  <code className="font-mono">vectorWeight</code>
                </td>
                <td className="py-2">
                  Reciprocal-rank fusion, no weights; all searches take{" "}
                  <code className="font-mono">{`{ path?, limit?, perFileCap? }`}</code>
                </td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4">
                  <code className="font-mono">
                    embed: (text) =&gt; Promise&lt;number[]&gt;
                  </code>
                </td>
                <td className="py-2">
                  <code className="font-mono">
                    embed: (texts) =&gt; Promise&lt;number[][]&gt;
                  </code>{" "}
                  (batch, one vector per text)
                </td>
              </tr>
              <tr>
                <td className="py-2 pr-4">
                  Embeddings computed on <code className="font-mono">writeFile</code>
                </td>
                <td className="py-2">
                  The write path never embeds — run{" "}
                  <code className="font-mono">indexChunkEmbeddings()</code>{" "}
                  explicitly
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          1. Update Search Consumers
        </h2>
        <CodeBlock
          code={`// 2.x
const results = await fs.textSearch("shipping")
for (const r of results) console.log(r.name, r.snippet)

// 3.0 — the hit is the snippet, with an exact address
const hits = await fs.textSearch("shipping")
for (const h of hits) console.log(\`\${h.path}:\${h.startLine}-\${h.endLine}\`, h.content)

// need the section verbatim? hydrate the line range
const { content } = await fs.readFileLines(hits[0].path, {
  offset: hits[0].startLine,
  limit: hits[0].endLine - hits[0].startLine + 1,
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          2. Batch the Embedder
        </h2>
        <CodeBlock
          code={`// 2.x — one text per call
embed: async (text) => {
  const res = await openai.embeddings.create({ model, input: text })
  return res.data[0].embedding
}

// 3.0 — a batch per call, one vector per text
embed: async (texts) => {
  const res = await openai.embeddings.create({ model, input: texts })
  return res.data.map((d) => d.embedding)
}`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          3. Migrate the Database
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          3.0 adds two tables —{" "}
          <code className="font-mono text-foreground/80">fs_blob_chunks</code>{" "}
          (the chunk index) and{" "}
          <code className="font-mono text-foreground/80">
            fs_chunk_embeddings
          </code>{" "}
          (the vector cache) — and no longer touches the old blob-level
          index. The migration is additive: re-run the idempotent{" "}
          <code className="font-mono text-foreground/80">setup()</code>{" "}
          (native), or re-run{" "}
          <code className="font-mono text-foreground/80">
            drizzle-kit generate
          </code>{" "}
          plus{" "}
          <code className="font-mono text-foreground/80">
            generateMigrationSQL()
          </code>{" "}
          (Drizzle). Older bash-gres versions keep working against a migrated
          database.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          4. Index Existing Content
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Enable{" "}
          <code className="font-mono text-foreground/80">chunking</code>{" "}
          on your instances, then run two idempotent passes once per workspace.
          Both scope to the handle&apos;s current version:
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({ db, workspaceId, chunking: true, embed, embeddingDimensions })

await fs.backfillChunks()        // chunk content written before 3.0
await fs.indexChunkEmbeddings()  // fill the vector cache (skip if BM25-only)`}
        />
      </section>

    </div>
  );
}
