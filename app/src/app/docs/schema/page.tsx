import { CodeBlock } from "@/components/code-block";

export default function SchemaPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Schema & Setup
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres stores versioned filesystem state across small relational
          tables: version roots, version labels, ancestor closure rows, entries,
          and deduplicated blobs. Paths use PostgreSQL{" "}
          <code className="font-mono text-foreground/80">ltree</code>, and RLS
          isolates every table by workspace.
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
          The core tables separate the workspace isolation boundary from the
          versioning boundary. A version root is usually{" "}
          <code className="font-mono text-foreground/80">/</code>, but a
          directory created with{" "}
          <code className="font-mono text-foreground/80">versioned: true</code>{" "}
          gets its own row in{" "}
          <code className="font-mono text-foreground/80">fs_version_roots</code>.
        </p>
        <CodeBlock
          lang="sql"
          code={`CREATE TABLE fs_version_roots (
    id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    workspace_id  text NOT NULL,
    path          ltree NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, path)
);

CREATE TABLE fs_versions (
    id                 bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    workspace_id       text NOT NULL,
    version_root_id    bigint REFERENCES fs_version_roots(id) ON DELETE RESTRICT,
    label              text NOT NULL,
    parent_version_id  bigint REFERENCES fs_versions(id) ON DELETE RESTRICT,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE version_ancestors (
    workspace_id   text NOT NULL,
    descendant_id  bigint NOT NULL,
    ancestor_id    bigint NOT NULL,
    depth          int NOT NULL CHECK (depth >= 0),
    PRIMARY KEY (workspace_id, descendant_id, ancestor_id)
);

CREATE TABLE fs_blobs (
    workspace_id  text NOT NULL,
    hash          bytea NOT NULL,
    content       text,
    binary_data   bytea,
    size_bytes    bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, hash)
);

CREATE TABLE fs_entries (
    workspace_id    text NOT NULL,
    version_id      bigint NOT NULL,
    path            ltree NOT NULL,
    blob_hash       bytea,
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink', 'tombstone')),
    symlink_target  text,
    mode            int NOT NULL DEFAULT 420,
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, version_id, path)
);`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">fs_versions.label</code>{" "}
          is unique per version root, so two versioned directories in the same
          workspace can both have labels like{" "}
          <code className="font-mono text-foreground/80">main</code> and{" "}
          <code className="font-mono text-foreground/80">draft</code>. See{" "}
          <a
            href="/docs/versioning"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            Versioning
          </a>{" "}
          for the API.
        </p>
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
                <td className="py-2 pr-4 font-mono">idx_fs_entries_path_gist</td>
                <td className="py-2 pr-4">GiST</td>
                <td className="py-2">Subtree scans for directory listing, walk, glob, usage, and diff</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">unique_workspace_version_root_label</td>
                <td className="py-2 pr-4">B-tree</td>
                <td className="py-2">Unique version labels inside each version root</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_entries_path_version</td>
                <td className="py-2 pr-4">B-tree</td>
                <td className="py-2">Visibility lookups by workspace, path, and version</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_version_ancestors_depth</td>
                <td className="py-2 pr-4">B-tree</td>
                <td className="py-2">Nearest-ancestor scans for copy-on-write visibility</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">idx_fs_blobs_content_bm25</td>
                <td className="py-2 pr-4">BM25</td>
                <td className="py-2">Full-text search on content (optional)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">idx_fs_blobs_embedding</td>
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

export const schema = createSchema({
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
// ALTER TABLE fs_entries ENABLE ROW LEVEL SECURITY;
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
