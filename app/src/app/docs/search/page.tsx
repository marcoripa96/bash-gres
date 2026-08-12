import { CodeBlock } from "@/components/code-block";

export default function SearchPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Search
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          Chunk-granular search in three modes: BM25 full-text via{" "}
          <a
            href="https://github.com/timescale/pg_textsearch"
            className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            pg_textsearch
          </a>
          , vector similarity via{" "}
          <a
            href="https://github.com/pgvector/pgvector"
            className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            pgvector
          </a>
          , and hybrid fusing both. Hits are ranked <em>sections</em>, each
          addressable as{" "}
          <code className="font-mono text-foreground/80">
            path:startLine-endLine
          </code>{" "}
          and hydratable with{" "}
          <code className="font-mono text-foreground/80">readFileLines()</code>.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Chunking</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Text files are indexed as markdown-aware <em>section chunks</em>:
          heading-bounded slices with 1-indexed line ranges, a heading
          breadcrumb (&quot;Title &gt; Section&quot;), and a token budget that
          fits embedding models. Chunks are keyed by the blob hash, so
          unchanged content is never re-chunked — across rewrites, copies,
          versions, and branches. Chunking is off by default; enable it per
          instance:
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1", chunking: true })
// or tune: chunking: { maxTokens: 480, volatileFrontmatterKeys: ["fetchedAt"] }

await fs.writeFile("/docs/page.md", markdown) // chunks stored with the write
const chunks = await fs.readFileChunks("/docs/page.md")
// [{ chunkIndex, startLine, endLine, headingPath, content }, ...]`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Pre-existing content (written before chunking was enabled) is
          indexed by one idempotent pass:{" "}
          <code className="font-mono text-foreground/80">
            await fs.backfillChunks()
          </code>
          . It chunks the text blobs visible at the handle&apos;s version and
          is safe to re-run.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Full-Text Search
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          BM25-ranked lexical search over the chunks. Requires{" "}
          <code className="font-mono text-foreground/80">
            enableFullTextSearch: true
          </code>{" "}
          in setup (the default).
        </p>
        <CodeBlock
          code={`const hits = await fs.textSearch("shipping costs", { path: "/docs", limit: 10 })
// [{ path: "/docs/faq.md", startLine: 12, endLine: 34,
//    headingPath: "FAQ > Shipping", content: "...", rank: 1.42 }, ...]

// hydrate a hit with the exact section text
const { content } = await fs.readFileLines(hits[0].path, {
  offset: hits[0].startLine,
  limit: hits[0].endLine - hits[0].startLine + 1,
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Embedding Pass
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Semantic and hybrid search read a per-content vector cache
          (
          <code className="font-mono text-foreground/80">
            fs_chunk_embeddings
          </code>
          , keyed by chunk content hash) that only an explicit pass fills —
          never the write path. The one batch{" "}
          <code className="font-mono text-foreground/80">embed</code> option
          serves both the indexing pass and query embedding. The pass is{" "}
          <em>version-scoped</em>: it embeds what the handle&apos;s current
          version serves, so branch → index → promote makes the new main
          fully indexed the moment it becomes visible, and stale versions
          never cost an embedding call.
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  chunking: { volatileFrontmatterKeys: ["fetchedAt"] }, // keep re-crawls cache-stable
  embed: async (texts) => {                             // one vector per text, batched
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    })
    return res.data.map((d) => d.embedding)
  },
  embeddingDimensions: 1536,
})

const branch = await fs.fork("crawl")
// ... writes (chunks ride along) ...
await branch.indexChunkEmbeddings()
// { chunks: 120, cacheHits: 118, embedded: 2 } — only changed sections embed
await branch.promoteTo("main")`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Requires{" "}
          <code className="font-mono text-foreground/80">
            enableVectorSearch: true
          </code>{" "}
          +{" "}
          <code className="font-mono text-foreground/80">
            embeddingDimensions
          </code>{" "}
          in setup. The cache is content-addressed: identical sections
          anywhere in the workspace share one vector, and content that comes
          back after a revert still cache-hits.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Semantic Search
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Ranks embedded chunks by cosine similarity. Nearest-neighbor
          semantics: it always ranks something, so irrelevant queries return
          low-rank hits rather than nothing — and chunks not yet embedded are
          invisible to it.
        </p>
        <CodeBlock
          code={`const similar = await fs.semanticSearch("how do refunds work", { limit: 10 })
// same result shape as textSearch()`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Hybrid Search</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Fuses the BM25 and vector rankings with reciprocal-rank fusion —
          rank-based, not score-based, because BM25 scores and cosine
          similarities aren&apos;t on comparable scales. An exact rare token
          and a synonym-only paraphrase each still surface, and chunks
          without a cached embedding stay reachable through the lexical side.
          Requires both the full-text and vector setups.
        </p>
        <CodeBlock
          code={`const hits = await fs.hybridSearch("delivery options", { perFileCap: 2 })
// same result shape as textSearch()/semanticSearch()`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          semgrep in Bash Sessions
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The{" "}
          <code className="font-mono text-foreground/80">semgrep</code>{" "}
          custom command puts all of this inside a just-bash session — hybrid
          when the handle has an embedder, BM25-only otherwise. See{" "}
          <a
            href="/docs/bash"
            className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
          >
            Bash
          </a>
          .
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          ChunkSearchResult
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Property</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Type</th>
                <th className="py-2 font-medium text-foreground/80">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">path</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2">Full path to the file containing the section</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">startLine</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">1-indexed first line of the section (inclusive)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">endLine</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">1-indexed last line of the section (inclusive)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">headingPath</td>
                <td className="py-2 pr-4 font-mono">string | null</td>
                <td className="py-2">Heading breadcrumb (&quot;Title &gt; H2 &gt; H3&quot;), if any</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">content</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2">The indexed text: breadcrumb prefix + section body</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">rank</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">Relevance score (higher = more relevant)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Search Options
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          All three searches take the same options:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Option</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Type</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Default</th>
                <th className="py-2 font-medium text-foreground/80">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">path</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2 pr-4 font-mono">&quot;/&quot;</td>
                <td className="py-2">Scope search to a subdirectory</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">limit</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">20</td>
                <td className="py-2">Max results (clamped to 1&ndash;100)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">perFileCap</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">3</td>
                <td className="py-2">Max hits per file, so one long page can&apos;t monopolize the top-k</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-sm text-muted-foreground leading-relaxed">
        Upgrading from the 2.x file-level search API? See the{" "}
        <a
          href="/docs/migration"
          className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
        >
          migration guide
        </a>
        .
      </p>
    </div>
  );
}
