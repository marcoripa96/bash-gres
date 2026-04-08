import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { DriverTabProvider } from "@/components/driver-tab-context";
import { highlight } from "@/lib/highlight";

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

// Creates table, indexes, extensions, RLS (idempotent)
await setup(sql)

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })`,
  },
  {
    label: "node-postgres",
    code: `import pg from "pg"
import { setup, PgFileSystem } from "bash-gres/node-postgres"

const pool = new pg.Pool({ connectionString: "postgres://localhost:5432/myapp" })

// Creates table, indexes, extensions, RLS (idempotent)
await setup(pool)

const fs = new PgFileSystem({ db: pool, workspaceId: "workspace-1" })`,
  },
  {
    label: "Drizzle ORM",
    code: `import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { setup, PgFileSystem } from "bash-gres/drizzle"

const sql = postgres("postgres://localhost:5432/myapp")
const db = drizzle(sql)

await setup(db)

const fs = new PgFileSystem({ db, workspaceId: "workspace-1" })`,
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

export default async function ConnectPage() {
  const [installTabs, connectTabs] = await Promise.all([
    buildTabs(INSTALL_TABS),
    buildTabs(CONNECT_TABS),
  ]);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Connect
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres requires PostgreSQL with the{" "}
          <code className="font-mono text-foreground/80">ltree</code>{" "}
          extension. Pick your database driver:
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
        <h2 className="text-xl font-semibold tracking-tight">Setup</h2>
        <CodeTabs tabs={connectTabs} />
      </section>
      </DriverTabProvider>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Docker Compose
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The easiest way to get a compatible PostgreSQL instance running:
        </p>
        <CodeBlock
          lang="yaml"
          filename="docker-compose.yml"
          code={`services:
  postgres:
    image: postgres:18
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres`}
        />
        <CodeBlock lang="bash" code={`docker compose up -d`} />
      </section>
    </div>
  );
}
