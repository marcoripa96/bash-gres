import type { Metadata } from "next";
import { Hero } from "@/components/hero";
import { Footer } from "@/components/footer";
import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { DriverTabProvider } from "@/components/driver-tab-context";
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
  { id: "connect", label: "02. Connect" },
  { id: "filesystem", label: "03. Filesystem" },
  { id: "bash", label: "04. Bash" },
];

const INSTALL_TABS = [
  { label: "postgres.js", code: `npm install bash-gres postgres just-bash`, lang: "bash" },
  { label: "node-postgres", code: `npm install bash-gres pg just-bash`, lang: "bash" },
  { label: "Drizzle ORM", code: `npm install bash-gres drizzle-orm just-bash`, lang: "bash" },
];

const CONNECT_TABS = [
  {
    label: "postgres.js",
    code: `import postgres from "postgres"
import { setup, PgFileSystem } from "bash-gres/postgres"

const sql = postgres("postgres://localhost:5432/myapp")

await setup(sql) // idempotent, safe on every startup

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })`,
  },
  {
    label: "node-postgres",
    code: `import pg from "pg"
import { setup, PgFileSystem } from "bash-gres/node-postgres"

const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/myapp" })

await setup(pool) // idempotent, safe on every startup

const fs = new PgFileSystem({ db: pool, workspaceId: "workspace-1" })`,
  },
  {
    label: "Drizzle ORM",
    code: `// schema.ts
import { createSchema } from "bash-gres/drizzle"
export const fsNodes = createSchema()

// app.ts
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { setup, PgFileSystem } from "bash-gres/drizzle"
import { fsNodes } from "./schema"

const sql = postgres("postgres://localhost:5432/myapp")
const db = drizzle(sql, { schema: { fsNodes } })

await setup(db)

const fs = new PgFileSystem({ db, workspaceId: "workspace-1" })`,
  },
];

const BASH_CODE = `import { Bash } from "just-bash"
import { PgFileSystem } from "bash-gres"

const fs = new PgFileSystem({ db: client, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

// A full bash environment, backed by PostgreSQL
await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")`;

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
  const [installTabs, connectTabs] = await Promise.all([
    buildTabs(INSTALL_TABS),
    buildTabs(CONNECT_TABS),
  ]);

  return (
    <>
      <Hero />
      <FloatingToc items={TOC} />
      <main className="max-w-[768px] mx-auto px-6 lg:px-8 pt-20 lg:pt-28 pb-24">
        <div className="space-y-20">
          <DriverTabProvider defaultLabel="postgres.js">
          {/* Install */}
          <Section id="install" label="01" title="Install">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Install BashGres with your preferred PostgreSQL driver and{" "}
              <a
                href="https://github.com/nichochar/just-bash"
                className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                just-bash
              </a>
              :
            </p>
            <CodeTabs tabs={installTabs} />
          </Section>

          {/* Connect */}
          <Section id="connect" label="02" title="Connect">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Create a{" "}
              <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
              , a PostgreSQL-backed virtual filesystem scoped to a workspace.{" "}
              <code className="font-mono text-foreground/80">setup()</code>{" "}
              creates tables, indexes, and extensions idempotently.
            </p>
            <CodeTabs tabs={connectTabs} />
          </Section>
          </DriverTabProvider>

          {/* Filesystem */}
          <Section id="filesystem" label="03" title="Filesystem">
            <p className="text-sm text-muted-foreground leading-relaxed">
              The API mirrors Node.js{" "}
              <code className="font-mono text-foreground/80">fs</code>.
              All operations are transactional and scoped to the workspace.
            </p>
            <CodeBlock
              code={`// Write & read
await fs.writeFile("/docs/guide.md", "# Getting Started")
await fs.mkdir("/docs/images", { recursive: true })
const content = await fs.readFile("/docs/guide.md")
const entries = await fs.readdir("/docs")

// Copy, move, remove
await fs.cp("/docs", "/backup", { recursive: true })
await fs.mv("/backup/guide.md", "/archive/guide.md")
await fs.rm("/archive", { recursive: true, force: true })

// Symlinks & stats
await fs.symlink("/docs/guide.md", "/latest")
const stat = await fs.stat("/docs/guide.md")
const tree = await fs.walk("/docs")`}
            />
            <CodeBlock
              code={`// Full-text search (BM25 via pg_textsearch)
const results = await fs.textSearch("machine learning", {
  path: "/docs",
  limit: 20,
})

// Semantic search (pgvector)
const similar = await fs.semanticSearch("how do LLMs work", {
  path: "/docs",
  limit: 10,
})

// Hybrid: BM25 + vector combined
const hybrid = await fs.hybridSearch("transformer architecture", {
  path: "/docs",
  textWeight: 0.4,
  vectorWeight: 0.6,
})`}
            />
          </Section>

          {/* Bash */}
          <Section id="bash" label="04" title="Bash">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Pass <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
              to{" "}
              <a
                href="https://github.com/nichochar/just-bash"
                className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                just-bash
              </a>{" "}
              and get a complete bash environment: 60+ commands,
              pipes, redirects, variables, loops, all persisted in
              PostgreSQL.
            </p>
            <CodeBlock code={BASH_CODE} />
          </Section>
        </div>
      </main>
      <Footer />
    </>
  );
}
