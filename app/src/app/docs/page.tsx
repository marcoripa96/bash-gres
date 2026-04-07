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
