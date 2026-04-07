import type { Metadata } from "next";
import { Hero } from "@/components/hero";
import { Footer } from "@/components/footer";
import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { ScrollReveal } from "@/components/scroll-reveal";
import { FloatingToc } from "@/components/floating-toc";
import { highlight } from "@/lib/highlight";

export const metadata: Metadata = {
  title: "BashGres -- PostgreSQL-backed Virtual Filesystem",
  description:
    "A virtual filesystem backed by PostgreSQL with a native bash command interface. Full-text search, semantic search, multi-tenant isolation. Built for AI agents.",
};

function Section({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <ScrollReveal>
        <p className="font-mono text-xs font-medium tracking-widest uppercase text-muted mb-2">
          {label}
        </p>
        <h2 className="text-2xl md:text-3xl tracking-tighter leading-none font-semibold">
          {title}
        </h2>
      </ScrollReveal>
      <ScrollReveal delay={0.1}>
        <div className="mt-6 space-y-6">{children}</div>
      </ScrollReveal>
    </section>
  );
}

const TOC = [
  { id: "install", label: "01. Install" },
  { id: "database", label: "02. Database" },
  { id: "connect", label: "03. Connect" },
  { id: "schema", label: "04. Schema" },
  { id: "filesystem", label: "05. Filesystem" },
  { id: "bash", label: "06. just-bash" },
  { id: "search", label: "07. Search" },
  { id: "config", label: "08. Config" },
];

const INSTALL_TABS = [
  { label: "npm", code: `npm install bash-gres`, lang: "bash" },
  { label: "pnpm", code: `pnpm add bash-gres`, lang: "bash" },
  { label: "yarn", code: `yarn add bash-gres`, lang: "bash" },
];

const DRIVER_TABS = [
  { label: "postgres.js", code: `npm install postgres`, lang: "bash" },
  { label: "Drizzle ORM", code: `npm install drizzle-orm`, lang: "bash" },
];

const CONNECT_TABS = [
  {
    label: "postgres.js",
    code: `import postgres from "postgres"
import { createPostgresClient } from "bash-gres/postgres"
import { setup, PgFileSystem } from "bash-gres"

const sql = postgres("postgres://postgres:postgres@localhost:5432/myapp")
const client = createPostgresClient(sql)

// Initialize schema (idempotent — safe to call on every startup)
await setup(client)

// Create a filesystem scoped to a workspace
const fs = new PgFileSystem({
  db: client,
  workspaceId: "workspace-1",
})`,
  },
  {
    label: "Drizzle ORM",
    code: `import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { createDrizzleClient } from "bash-gres/drizzle"
import { PgFileSystem } from "bash-gres"

const sql = postgres("postgres://postgres:postgres@localhost:5432/myapp")
const db = drizzle(sql)
const client = createDrizzleClient(db)

const fs = new PgFileSystem({
  db: client,
  workspaceId: "workspace-1",
})`,
  },
];

const DRIZZLE_SCHEMA_TABS = [
  {
    label: "schema.ts",
    code: `import { createSchema } from "bash-gres/drizzle"

// Generates the fs_nodes table with all indexes
// Pass this to your drizzle() config so drizzle-kit picks it up
export const fsNodes = createSchema({
  enableFullTextSearch: true,   // BM25 index on content
  enableVectorSearch: false,    // pgvector HNSW index
  embeddingDimensions: 1536,    // required if enableVectorSearch
})`,
  },
  {
    label: "drizzle.config.ts",
    code: `import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgres://postgres:postgres@localhost:5432/myapp",
  },
})`,
  },
  {
    label: "migration.ts",
    code: `import { generateMigrationSQL } from "bash-gres/drizzle"

// Generates SQL for extensions and RLS policies that
// drizzle-kit can't express — paste into a custom migration
const sql = generateMigrationSQL({
  enableRLS: true,
  enableFullTextSearch: true,
  enableVectorSearch: false,
})

console.log(sql)
// CREATE EXTENSION IF NOT EXISTS ltree;
// CREATE EXTENSION IF NOT EXISTS pg_textsearch;
// ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
// ...`,
  },
];

const BASH_CODE = `import { Bash } from "just-bash"
import { PgFileSystem } from "bash-gres"

const fs = new PgFileSystem({ db: client, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\\n", stderr: "" }

// Pipes, redirects, globs, operators
await bash.exec("cat /project/src/index.ts | wc -l")
await bash.exec('echo "appended" >> /project/src/index.ts')
await bash.exec("ls /project/src/*.ts && echo 'found'")

// 60+ commands: find, grep, sed, awk, jq, sort, ...
await bash.exec("find /project -name '*.ts' -type f")
await bash.exec("grep -r 'hello' /project")`;

async function buildTabs(
  tabs: { label: string; code: string; lang?: string }[]
) {
  const highlighted = await Promise.all(
    tabs.map((t) => highlight(t.code, t.lang ?? "typescript"))
  );
  return tabs.map((t, i) => ({
    label: t.label,
    code: t.code,
    html: highlighted[i],
  }));
}

export default async function Home() {
  const [installTabs, driverTabs, connectTabs, drizzleSchemaTabs] =
    await Promise.all([
      buildTabs(INSTALL_TABS),
      buildTabs(DRIVER_TABS),
      buildTabs(CONNECT_TABS),
      buildTabs(DRIZZLE_SCHEMA_TABS),
    ]);

  return (
    <>
      <Hero />
      <FloatingToc items={TOC} />
      <main className="max-w-[768px] mx-auto px-6 lg:px-8 pt-20 lg:pt-28 pb-24">
        <div className="space-y-20">
          {/* Install */}
          <Section id="install" label="01" title="Install">
            <CodeTabs tabs={installTabs} />
            <p className="text-sm text-muted-foreground leading-relaxed">
              Then install the database driver you use:
            </p>
            <CodeTabs tabs={driverTabs} />
          </Section>

          {/* Database */}
          <Section id="database" label="02" title="Database">
            <p className="text-sm text-muted-foreground leading-relaxed">
              BashGres requires PostgreSQL with the{" "}
              <code className="font-mono text-foreground/80">ltree</code>{" "}
              extension. The easiest way to get started:
            </p>
            <CodeBlock
              lang="yaml"
              filename="docker-compose.yml"
              code={`services:
  postgres:
    image: postgres:17
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    command: >
      postgres
        -c shared_preload_libraries=ltree`}
            />
            <CodeBlock lang="bash" code={`docker compose up -d`} />
          </Section>

          {/* Connect */}
          <Section id="connect" label="03" title="Connect">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Wrap your database connection into a{" "}
              <code className="font-mono text-foreground/80">SqlClient</code>,
              then pass it to{" "}
              <code className="font-mono text-foreground/80">PgFileSystem</code>
              . With postgres.js,{" "}
              <code className="font-mono text-foreground/80">setup()</code>{" "}
              handles everything. With Drizzle, use the schema and migration
              helpers instead.
            </p>
            <CodeTabs tabs={connectTabs} />
            <div className="border-t border-border/50 pt-6">
              <p className="font-mono text-xs font-medium tracking-wide uppercase text-foreground mb-2">
                Drizzle schema & migrations
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                <code className="font-mono text-foreground/80">
                  createSchema()
                </code>{" "}
                generates the table and indexes so{" "}
                <code className="font-mono text-foreground/80">
                  drizzle-kit generate
                </code>{" "}
                picks them up.{" "}
                <code className="font-mono text-foreground/80">
                  generateMigrationSQL()
                </code>{" "}
                outputs the extensions and RLS policies that Drizzle can&apos;t
                express — paste it into a custom migration.
              </p>
              <CodeTabs tabs={drizzleSchemaTabs} />
              <CodeBlock
                lang="bash"
                code={`# Generate the table migration, then add a custom one for extensions + RLS
npx drizzle-kit generate
npx drizzle-kit generate --custom
npx drizzle-kit migrate`}
              />
            </div>
          </Section>

          {/* Schema */}
          <Section id="schema" label="04" title="Initialize the schema">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <code className="font-mono text-foreground/80">setup()</code>{" "}
              creates the table, indexes, extensions, and optionally enables RLS
              and vector search. It&apos;s idempotent — call it on every startup.
            </p>
            <CodeBlock
              code={`import { setup } from "bash-gres"

await setup(client, {
  enableRLS: true,              // Row-Level Security (default: true)
  enableFullTextSearch: true,   // BM25 index (default: true)
  enableVectorSearch: false,    // pgvector (default: false)
  embeddingDimensions: 1536,    // required if enableVectorSearch
  skipExtensions: false,        // set true if extensions already exist
})`}
            />
          </Section>

          {/* Filesystem */}
          <Section id="filesystem" label="05" title="Filesystem operations">
            <p className="text-sm text-muted-foreground leading-relaxed">
              The API mirrors Node.js{" "}
              <code className="font-mono text-foreground/80">fs</code>. All
              operations are transactional and scoped to the workspace.
            </p>
            <CodeBlock
              code={`// Write
await fs.writeFile("/docs/guide.md", "# Getting Started")
await fs.mkdir("/docs/images", { recursive: true })
await fs.appendFile("/docs/guide.md", "\\nMore content...")

// Read
const content = await fs.readFile("/docs/guide.md")
const entries = await fs.readdir("/docs")
const stats = await fs.stat("/docs/guide.md")
const exists = await fs.exists("/docs/guide.md")

// Walk
const tree = await fs.walk("/docs")
// [{ path, name, type, depth }]

// Copy, move, remove
await fs.cp("/docs", "/backup", { recursive: true })
await fs.mv("/backup/guide.md", "/archive/guide.md")
await fs.rm("/archive", { recursive: true, force: true })

// Symlinks
await fs.symlink("/docs/guide.md", "/latest")
const target = await fs.readlink("/latest")`}
            />
          </Section>

          {/* Bash */}
          <Section id="bash" label="06" title="Bash">
            <p className="text-sm text-muted-foreground leading-relaxed">
              PgFileSystem implements the{" "}
              <a
                href="https://github.com/nichochar/just-bash"
                className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                just-bash
              </a>{" "}
              filesystem interface. Pass it directly to get 60+ bash commands,
              pipes, redirects, variables, loops, and more.
            </p>
            <CodeBlock code={BASH_CODE} />
          </Section>

          {/* Search */}
          <Section id="search" label="07" title="Search">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Three search modes. Full-text uses BM25 ranking powered by{" "}
              <a
                href="https://github.com/timescale/pg_textsearch"
                className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                pg_textsearch
              </a>{" "}
              from Timescale. Semantic and hybrid search use pgvector.
            </p>
            <CodeBlock
              code={`// Full-text search (BM25 via pg_textsearch)
const results = await fs.textSearch("machine learning", {
  path: "/docs",    // scope to subdirectory
  limit: 20,        // max results
})
// [{ path, name, rank }]

// Semantic search (requires pgvector + embed function)
const similar = await fs.semanticSearch("how do LLMs work", {
  path: "/docs",
  limit: 10,
})

// Hybrid search: BM25 + vector combined
const hybrid = await fs.hybridSearch("transformer architecture", {
  path: "/docs",
  textWeight: 0.4,
  vectorWeight: 0.6,
  limit: 20,
})`}
            />
            <p className="text-sm text-muted-foreground leading-relaxed">
              For semantic and hybrid search, provide an{" "}
              <code className="font-mono text-foreground/80">embed</code>{" "}
              function when creating the filesystem:
            </p>
            <CodeBlock
              code={`const fs = new PgFileSystem({
  db: client,
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
          </Section>

          {/* Configuration */}
          <Section id="config" label="08" title="Configuration">
            <CodeBlock
              code={`const fs = new PgFileSystem({
  db: client,
  workspaceId: "workspace-1",

  // Limits
  maxFileSize: 10 * 1024 * 1024,   // 10 MB (default)
  maxReadSize: 5 * 1024 * 1024,    // limit read() size
  maxFiles: 10_000,                 // per workspace (default)
  maxDepth: 50,                     // path depth (default)
  statementTimeoutMs: 5000,         // query timeout (default)

  // Sandbox
  rootDir: "/",
  permissions: { read: true, write: true },

  // Vector search
  embed: undefined,
  embeddingDimensions: undefined,
})`}
            />
          </Section>
        </div>
      </main>
      <Footer />
    </>
  );
}
