import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { DriverTabProvider } from "@/components/driver-tab-context";
import { highlight } from "@/lib/highlight";

const INSTALL_TABS = [
  { label: "postgres.js", code: `npm install bash-gres postgres just-bash`, lang: "bash" },
  { label: "node-postgres", code: `npm install bash-gres pg just-bash`, lang: "bash" },
  { label: "Drizzle ORM", code: `npm install bash-gres drizzle-orm just-bash`, lang: "bash" },
];

const QUICKSTART_TABS = [
  {
    label: "postgres.js",
    code: `import postgres from "postgres"
import { Bash } from "just-bash"
import { setup, PgFileSystem } from "bash-gres/postgres"

const sql = postgres("postgres://localhost:5432/myapp")
await setup(sql)

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\\n", stderr: "" }`,
  },
  {
    label: "node-postgres",
    code: `import pg from "pg"
import { Bash } from "just-bash"
import { setup, PgFileSystem } from "bash-gres/node-postgres"

const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/myapp" })
await setup(pool)

const fs = new PgFileSystem({ db: pool, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\\n", stderr: "" }`,
  },
  {
    label: "Drizzle ORM",
    code: `import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { Bash } from "just-bash"
import { setup, PgFileSystem } from "bash-gres/drizzle"

const sql = postgres("postgres://localhost:5432/myapp")
const db = drizzle(sql)
await setup(db)

const fs = new PgFileSystem({ db, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\\n", stderr: "" }`,
  },
];

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

export default async function DocsOverview() {
  const [installTabs, quickstartTabs] = await Promise.all([
    buildTabs(INSTALL_TABS),
    buildTabs(QUICKSTART_TABS),
  ]);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Getting Started
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres is a PostgreSQL-backed virtual filesystem for AI agents. It
          implements the{" "}
          <a
            href="https://github.com/nichochar/just-bash"
            className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            just-bash
          </a>{" "}
          <code className="font-mono text-foreground/80">IFileSystem</code>{" "}
          interface, so you can pass it directly to{" "}
          <code className="font-mono text-foreground/80">new Bash({"{ fs }"})</code>{" "}
          and get a complete bash environment backed by PostgreSQL.
        </p>
      </header>

      <DriverTabProvider defaultLabel="postgres.js">
      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Install</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Install BashGres with your preferred PostgreSQL driver and{" "}
          <code className="font-mono text-foreground/80">just-bash</code>:
        </p>
        <CodeTabs tabs={installTabs} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Quick Start</h2>
        <CodeTabs tabs={quickstartTabs} />
      </section>
      </DriverTabProvider>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Requirements</h2>
        <ul className="text-sm text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
          <li>
            PostgreSQL 15+ with the{" "}
            <code className="font-mono text-foreground/80">ltree</code>{" "}
            extension
          </li>
          <li>
            Node.js 18+
          </li>
          <li>
            Optional:{" "}
            <code className="font-mono text-foreground/80">pg_textsearch</code>{" "}
            for BM25 full-text search
          </li>
          <li>
            Optional:{" "}
            <code className="font-mono text-foreground/80">pgvector</code>{" "}
            for semantic/hybrid search
          </li>
        </ul>
      </section>
    </div>
  );
}
