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
          interface. Pass it directly to get a complete bash environment &mdash;
          60+ commands, pipes, redirects, variables, loops &mdash; all persisted
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

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Pipes & Redirects
        </h2>
        <CodeBlock
          code={`// Pipes
await bash.exec("cat /project/src/index.ts | wc -l")
await bash.exec("ls /project/src | sort | head -5")

// Redirects
await bash.exec('echo "appended" >> /project/src/index.ts')
await bash.exec("cat /project/src/index.ts > /project/src/copy.ts")

// Stderr redirect
await bash.exec("ls /nonexistent 2>/dev/null")`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Globs, Variables & Loops
        </h2>
        <CodeBlock
          code={`// Glob expansion
await bash.exec("ls /project/src/*.ts")

// Variables
await bash.exec('NAME="world" && echo "hello $NAME"')

// Loops
await bash.exec("for f in /project/src/*.ts; do wc -l $f; done")

// Conditionals
await bash.exec("ls /project/src/*.ts && echo 'found' || echo 'empty'")`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Available Commands
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          just-bash provides 60+ commands that work with PgFileSystem out of the
          box:
        </p>
        <div className="bg-surface/50 border border-border/50 rounded-xl p-5">
          <div className="font-mono text-[13px] text-muted-foreground leading-relaxed space-y-2">
            <p>
              <span className="text-foreground/80">Files:</span>{" "}
              cat, head, tail, cp, mv, rm, touch, tee, truncate
            </p>
            <p>
              <span className="text-foreground/80">Directories:</span>{" "}
              ls, mkdir, rmdir, pwd, cd, basename, dirname
            </p>
            <p>
              <span className="text-foreground/80">Search:</span>{" "}
              find, grep, wc, diff
            </p>
            <p>
              <span className="text-foreground/80">Text:</span>{" "}
              sed, awk, sort, uniq, cut, tr, rev, fold, paste, join, comm
            </p>
            <p>
              <span className="text-foreground/80">Data:</span>{" "}
              jq, base64, md5sum, sha256sum, xxd
            </p>
            <p>
              <span className="text-foreground/80">Shell:</span>{" "}
              echo, printf, read, test, expr, true, false, exit, sleep, date, env, export, unset, xargs
            </p>
            <p>
              <span className="text-foreground/80">Links:</span>{" "}
              ln, readlink, realpath
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          ExecResult
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every{" "}
          <code className="font-mono text-foreground/80">bash.exec()</code>{" "}
          call returns:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Property</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Type</th>
                <th className="py-2 font-medium text-foreground/80">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">stdout</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2">Standard output</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">stderr</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2">Standard error</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">exitCode</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">Exit status (0 = success)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">env</td>
                <td className="py-2 pr-4 font-mono">Record&lt;string, string&gt;</td>
                <td className="py-2">Final environment variables</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Custom Commands
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          You can register custom commands that run alongside (or override)
          built-in commands. Custom commands take precedence over built-ins with
          the same name.
        </p>
        <CodeBlock
          code={`import { Bash, defineCommand } from "just-bash"

const hello = defineCommand("hello", async (args, ctx) => {
  return { stdout: \`Hello, \${args[0] ?? "world"}!\\n\`, stderr: "", exitCode: 0 }
})

const bash = new Bash({ fs, customCommands: [hello] })

await bash.exec("hello BashGres")
// { stdout: "Hello, BashGres!\\n", ... }`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Restricting Commands
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use the{" "}
          <code className="font-mono text-foreground/80">commands</code> option
          to allowlist only specific built-in commands:
        </p>
        <CodeBlock
          code={`const bash = new Bash({
  fs,
  commands: ["echo", "cat", "ls", "mkdir", "cp", "mv", "rm"],
})`}
        />
      </section>
    </div>
  );
}
