import { CodeBlock } from "@/components/code-block";

export default function SchemaPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Schema & Setup
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres uses a single{" "}
          <code className="font-mono text-foreground/80">fs_nodes</code> table
          with ltree paths, workspace isolation, and optional full-text and
          vector indexes.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          setup()
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The <code className="font-mono text-foreground/80">setup()</code>{" "}
          function creates everything idempotently. Safe to call on every
          startup. It works with both adapters.
        </p>
        <CodeBlock
          code={`import { setup } from "bash-gres/postgres" // or "bash-gres/drizzle"

await setup(sql, {
  enableRLS: true,              // Row-Level Security (default: true)
  enableFullTextSearch: true,   // BM25 index via pg_textsearch (default: true)
  enableVectorSearch: false,    // pgvector HNSW index (default: false)
  embeddingDimensions: 1536,    // required if enableVectorSearch is true
  skipExtensions: false,        // skip CREATE EXTENSION (default: false)
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          SetupOptions
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
                <td className="py-2 pr-4 font-mono">enableRLS</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2 pr-4 font-mono">true</td>
                <td className="py-2">Enable Row-Level Security for workspace isolation</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">enableFullTextSearch</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2 pr-4 font-mono">true</td>
                <td className="py-2">Create BM25 index on content (requires pg_textsearch)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">enableVectorSearch</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2 pr-4 font-mono">false</td>
                <td className="py-2">Add embedding column and HNSW index (requires pgvector)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">embeddingDimensions</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">-</td>
                <td className="py-2">Vector dimensions (required when enableVectorSearch is true)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">skipExtensions</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2 pr-4 font-mono">false</td>
                <td className="py-2">Skip CREATE EXTENSION if extensions already exist</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Table Schema
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The <code className="font-mono text-foreground/80">fs_nodes</code>{" "}
          table stores all files, directories, and symlinks:
        </p>
        <CodeBlock
          lang="sql"
          code={`CREATE TABLE fs_nodes (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    workspace_id    text NOT NULL,
    parent_id       bigint REFERENCES fs_nodes(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink')),
    path            ltree NOT NULL,
    content         text,
    binary_data     bytea,
    symlink_target  text,
    mode            int NOT NULL DEFAULT 420,     -- 0o644
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT unique_workspace_path UNIQUE (workspace_id, path)
);`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Indexes</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Index</th>
                <th className="py-2 pr-4 font-medium text-foreground/80">Type</th>
                <th className="py-2 font-medium text-foreground/80">Purpose</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_path_gist</td>
                <td className="py-2 pr-4">GiST</td>
                <td className="py-2">ltree ancestor/descendant queries</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_workspace_parent</td>
                <td className="py-2 pr-4">B-tree</td>
                <td className="py-2">Directory listing by parent</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_stat</td>
                <td className="py-2 pr-4">B-tree (covering)</td>
                <td className="py-2">stat() with INCLUDE (node_type, mode, size_bytes, mtime)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_dir_lookup</td>
                <td className="py-2 pr-4">B-tree (partial)</td>
                <td className="py-2">Fast directory lookups (WHERE node_type = &apos;directory&apos;)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_content_bm25</td>
                <td className="py-2 pr-4">BM25</td>
                <td className="py-2">Full-text search on content (optional)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">idx_fs_embedding</td>
                <td className="py-2 pr-4">HNSW</td>
                <td className="py-2">Vector similarity search (optional)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          PostgreSQL Extensions
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Extension</th>
                <th className="py-2 pr-4 font-medium text-foreground/80">Required</th>
                <th className="py-2 font-medium text-foreground/80">Purpose</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">ltree</td>
                <td className="py-2 pr-4">Always</td>
                <td className="py-2">Hierarchical path storage and queries</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">pg_textsearch</td>
                <td className="py-2 pr-4">If enableFullTextSearch</td>
                <td className="py-2">BM25-ranked full-text search</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">pgvector</td>
                <td className="py-2 pr-4">If enableVectorSearch</td>
                <td className="py-2">Embedding storage and HNSW similarity</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Drizzle Schema
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          If you use Drizzle ORM, use{" "}
          <code className="font-mono text-foreground/80">createSchema()</code>{" "}
          to generate the table definition so{" "}
          <code className="font-mono text-foreground/80">drizzle-kit</code>{" "}
          can manage migrations for you.
        </p>
        <CodeBlock
          filename="schema.ts"
          code={`import { createSchema } from "bash-gres/drizzle"

export const fsNodes = createSchema({
  enableFullTextSearch: true,   // BM25 index on content
  enableVectorSearch: false,    // pgvector HNSW index
  embeddingDimensions: 1536,    // required if enableVectorSearch
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Drizzle Migrations
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">
            generateMigrationSQL()
          </code>{" "}
          produces SQL for extensions and RLS policies that Drizzle can&apos;t
          express. Paste it into a custom migration.
        </p>
        <CodeBlock
          code={`import { generateMigrationSQL } from "bash-gres/drizzle"

const sql = generateMigrationSQL({
  enableRLS: true,
  enableFullTextSearch: true,
  enableVectorSearch: false,
})

console.log(sql)
// CREATE EXTENSION IF NOT EXISTS ltree;
// CREATE EXTENSION IF NOT EXISTS pg_textsearch;
// ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
// ...`}
        />
        <CodeBlock
          lang="bash"
          code={`# Generate the table migration, then add a custom one for extensions + RLS
npx drizzle-kit generate
npx drizzle-kit generate --custom
npx drizzle-kit migrate`}
        />
      </section>

    </div>
  );
}
