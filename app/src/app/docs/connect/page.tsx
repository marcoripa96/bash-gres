import { CodeBlock } from "@/components/code-block";

export default function ConnectPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Connect
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres requires PostgreSQL with the{" "}
          <code className="font-mono text-foreground/80">ltree</code>{" "}
          extension and supports two database drivers:{" "}
          <code className="font-mono text-foreground/80">postgres.js</code> and{" "}
          <code className="font-mono text-foreground/80">Drizzle ORM</code>.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">postgres.js</h2>
        <CodeBlock lang="bash" code={`npm install postgres`} />
        <CodeBlock
          code={`import postgres from "postgres"
import { setup, PgFileSystem } from "bash-gres/postgres"

const sql = postgres("postgres://localhost:5432/myapp")

// Creates table, indexes, extensions, RLS (idempotent)
await setup(sql)

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Drizzle ORM</h2>
        <CodeBlock lang="bash" code={`npm install drizzle-orm`} />
        <CodeBlock
          code={`import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { setup, PgFileSystem } from "bash-gres/drizzle"

const sql = postgres("postgres://localhost:5432/myapp")
const db = drizzle(sql)

await setup(db)

const fs = new PgFileSystem({ db, workspaceId: "workspace-1" })`}
        />
      </section>

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
