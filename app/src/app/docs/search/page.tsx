import { CodeBlock } from "@/components/code-block";

export default function SearchPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Search
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          Three search modes built on PostgreSQL: BM25 full-text search via{" "}
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
          , and hybrid combining both.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Full-Text Search
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Uses BM25 ranking for relevance-scored text search. Requires{" "}
          <code className="font-mono text-foreground/80">
            enableFullTextSearch: true
          </code>{" "}
          in setup (the default).
        </p>
        <CodeBlock
          code={`const results = await fs.textSearch("machine learning", {
  path: "/docs",    // scope to subdirectory (default: "/")
  limit: 20,        // max results (default: 20, max: 100)
})
// [{ path: "/docs/ml-intro.md", name: "ml-intro.md", rank: 1.42 }, ...]`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Semantic Search
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Vector-based similarity search using embeddings. Requires{" "}
          <code className="font-mono text-foreground/80">pgvector</code>,{" "}
          <code className="font-mono text-foreground/80">
            enableVectorSearch: true
          </code>{" "}
          in setup, and an{" "}
          <code className="font-mono text-foreground/80">embed</code> function
          on the filesystem instance.
        </p>
        <CodeBlock
          code={`const results = await fs.semanticSearch("how do LLMs work", {
  path: "/docs",
  limit: 10,
})
// [{ path: "/docs/llm-guide.md", name: "llm-guide.md", rank: 0.92 }, ...]`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Hybrid Search
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Combines BM25 and vector scores with configurable weights. Requires
          both full-text and vector search to be enabled.
        </p>
        <CodeBlock
          code={`const results = await fs.hybridSearch("transformer architecture", {
  path: "/docs",
  textWeight: 0.4,     // BM25 weight (default: 0.4)
  vectorWeight: 0.6,   // vector weight (default: 0.6)
  limit: 20,
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          SearchResult
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
                <td className="py-2">Full path to the matching file</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">name</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2">Filename</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">rank</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">Relevance score (higher = more relevant)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">snippet</td>
                <td className="py-2 pr-4 font-mono">string?</td>
                <td className="py-2">Optional text snippet with match context</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Embedding Function
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          For semantic and hybrid search, provide an{" "}
          <code className="font-mono text-foreground/80">embed</code> function
          when creating the filesystem. Embeddings are computed automatically on{" "}
          <code className="font-mono text-foreground/80">writeFile</code> and{" "}
          <code className="font-mono text-foreground/80">appendFile</code>.
        </p>
        <CodeBlock
          code={`import { PgFileSystem } from "bash-gres/postgres"

const fs = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  embed: async (text) => {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    })
    return res.data[0].embedding
  },
  embeddingDimensions: 1536,
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Search Options
        </h2>
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
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">textWeight</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">0.4</td>
                <td className="py-2">BM25 weight in hybrid search</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">vectorWeight</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">0.6</td>
                <td className="py-2">Vector weight in hybrid search</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
