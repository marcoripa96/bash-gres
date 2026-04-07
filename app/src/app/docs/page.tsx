import { CodeBlock } from "@/components/code-block";

export default function DocsOverview() {
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

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Install</h2>
        <CodeBlock lang="bash" code={`npm install bash-gres`} />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Then install your database driver and{" "}
          <code className="font-mono text-foreground/80">just-bash</code>:
        </p>
        <CodeBlock lang="bash" code={`npm install postgres just-bash`} />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Or if you use Drizzle ORM:
        </p>
        <CodeBlock lang="bash" code={`npm install drizzle-orm just-bash`} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Quick Start</h2>
        <CodeBlock
          code={`import postgres from "postgres"
import { Bash } from "just-bash"
import { setup, PgFileSystem } from "bash-gres/postgres"

const sql = postgres("postgres://localhost:5432/myapp")
await setup(sql)

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })
const bash = new Bash({ fs })

await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')
await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\\n", stderr: "" }`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Architecture</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          BashGres is split into a core package and two database adapters:
        </p>
        <div className="bg-surface/50 border border-border/50 rounded-xl p-5">
          <pre className="font-mono text-[13px] text-muted-foreground leading-relaxed">
{`bash-gres            Core: PgFileSystem, setup(), search, types
bash-gres/postgres   postgres.js adapter
bash-gres/drizzle    Drizzle ORM adapter + schema + migrations`}
          </pre>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The core operates on a{" "}
          <code className="font-mono text-foreground/80">SqlClient</code>{" "}
          interface. Each adapter wraps a driver-specific connection into{" "}
          <code className="font-mono text-foreground/80">SqlClient</code>.
          Both adapters also re-export{" "}
          <code className="font-mono text-foreground/80">setup()</code> and{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          that accept the native driver directly, so you never need to touch{" "}
          <code className="font-mono text-foreground/80">SqlClient</code>{" "}
          yourself.
        </p>
      </section>

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
