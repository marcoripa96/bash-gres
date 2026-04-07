import { CodeBlock } from "@/components/code-block";

export default function BashPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Bash
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
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
          interface. Pass it directly to get a complete bash environment:
          60+ commands, pipes, redirects, variables, loops, all persisted
          in PostgreSQL.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Setup</h2>
        <CodeBlock lang="bash" code={`npm install just-bash`} />
        <CodeBlock
          code={`import { Bash } from "just-bash"
import { PgFileSystem } from "bash-gres/postgres"

const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })
const bash = new Bash({ fs })`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Basic Commands
        </h2>
        <CodeBlock
          code={`await bash.exec("mkdir -p /project/src")
await bash.exec('echo "hello world" > /project/src/index.ts')

const result = await bash.exec("cat /project/src/index.ts")
// { exitCode: 0, stdout: "hello world\\n", stderr: "" }`}
        />
      </section>

      <p className="text-sm text-muted-foreground leading-relaxed">
        For the full list of commands, pipes, redirects, variables, and more,
        see the{" "}
        <a
          href="https://github.com/vercel-labs/just-bash"
          className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
          target="_blank"
          rel="noopener noreferrer"
        >
          just-bash documentation
        </a>
        .
      </p>
    </div>
  );
}
