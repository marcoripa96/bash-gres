import { CodeBlock } from "@/components/code-block";

export default function ConnectPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Connect
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres supports two database drivers:{" "}
          <code className="font-mono text-foreground/80">postgres.js</code> and{" "}
          <code className="font-mono text-foreground/80">Drizzle ORM</code>.
          Both are peer dependencies &mdash; install whichever you use.
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
        <p className="text-sm text-muted-foreground leading-relaxed">
          Under the hood,{" "}
          <code className="font-mono text-foreground/80">bash-gres/postgres</code>{" "}
          wraps the <code className="font-mono text-foreground/80">sql</code>{" "}
          instance into a{" "}
          <code className="font-mono text-foreground/80">SqlClient</code>{" "}
          automatically. If you need the raw client (e.g. to share with other
          code), use{" "}
          <code className="font-mono text-foreground/80">
            createPostgresClient(sql)
          </code>.
        </p>
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
        <p className="text-sm text-muted-foreground leading-relaxed">
          If you need the raw client, use{" "}
          <code className="font-mono text-foreground/80">
            createDrizzleClient(db)
          </code>.
          See the{" "}
          <a
            href="/docs/schema"
            className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
          >
            Schema & Setup
          </a>{" "}
          page for Drizzle schema and migration helpers.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          SqlClient Interface
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Both adapters produce a{" "}
          <code className="font-mono text-foreground/80">SqlClient</code>,
          which is what the core library operates on. You can also implement this
          interface for any other PostgreSQL driver.
        </p>
        <CodeBlock
          code={`interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: SqlParam[],
  ): Promise<QueryResult<T>>

  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>
}

type SqlParam = string | number | boolean | null
  | Uint8Array | Date | string[] | number[]

interface QueryResult<T> {
  rows: T[]
  rowCount: number | null
}`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Workspace Isolation
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          instance is scoped to a workspace. Workspaces are isolated via
          PostgreSQL Row-Level Security &mdash; each transaction sets{" "}
          <code className="font-mono text-foreground/80">
            SET LOCAL app.workspace_id
          </code>{" "}
          before executing any query. If you omit{" "}
          <code className="font-mono text-foreground/80">workspaceId</code>, a
          random UUID is generated.
        </p>
        <CodeBlock
          code={`// Each workspace is fully isolated
const ws1 = new PgFileSystem({ db: sql, workspaceId: "tenant-a" })
const ws2 = new PgFileSystem({ db: sql, workspaceId: "tenant-b" })

await ws1.writeFile("/data.txt", "tenant A data")
await ws2.exists("/data.txt") // false — different workspace`}
        />
      </section>
    </div>
  );
}
