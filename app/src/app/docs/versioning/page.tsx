import { CodeBlock } from "@/components/code-block";

export default function VersioningPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Versioning
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          Every{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          instance is bound to a{" "}
          <code className="font-mono text-foreground/80">version</code> within
          a workspace. Versions are fully isolated, so the same path can hold
          different contents across versions, and you can fork, list, and
          delete them. Use this to keep a working copy alongside deployed
          snapshots, diff two states, or roll back.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Basic Usage
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The <code className="font-mono text-foreground/80">version</code>{" "}
          option selects which version an instance reads from and writes to.
          If omitted, it defaults to{" "}
          <code className="font-mono text-foreground/80">&quot;main&quot;</code>.
        </p>
        <CodeBlock
          code={`// Scoped to (workspaceId, "v2")
const v2 = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  version: "v2",
})

await v2.writeFile("/config.json", '{"env":"staging"}')
await v2.readFile("/config.json") // '{"env":"staging"}'

// A different version sees nothing written in v2
const v3 = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  version: "v3",
})
await v3.exists("/config.json") // false`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Fork
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">fork(name)</code>{" "}
          copies every file and directory from the current version into a new
          one and returns a{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          bound to it. Writes to the fork never leak back to the source.
        </p>
        <CodeBlock
          code={`const v1 = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  version: "v1",
})

await v1.writeFile("/src/app.ts", "export default 1;")
await v1.writeFile("/readme.md", "# v1")

// Fork: copy v1 -> v2, return an fs bound to v2
const v2 = await v1.fork("v2")

await v2.writeFile("/readme.md", "# v2 modified")

await v1.readFile("/readme.md") // "# v1"        (unchanged)
await v2.readFile("/readme.md") // "# v2 modified"`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          List & Delete
        </h2>
        <CodeBlock
          code={`// All versions present in this workspace
const versions = await v1.listVersions()
// ["v1", "v2", "v3"]

// Remove a version (and all its rows). Throws if it's the current one.
await v1.deleteVersion("v2")`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Diffs
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The library doesn&apos;t ship a diff helper. Since each version is
          a regular filesystem, you can read the same path from two instances
          and diff the strings with whatever tool you already use.
        </p>
        <CodeBlock
          code={`const v1 = new PgFileSystem({ db: sql, workspaceId, version: "v1" })
const v2 = new PgFileSystem({ db: sql, workspaceId, version: "v2" })

const before = await v1.readFile("/src/app.ts")
const after  = await v2.readFile("/src/app.ts")

// Diff with your preferred library:
import { createTwoFilesPatch } from "diff"
const patch = createTwoFilesPatch("v1", "v2", before, after)`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Deploy Pattern
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          BashGres doesn&apos;t track a &quot;live&quot; version. That&apos;s
          application logic. A typical pattern: keep a pointer in your own
          config (or a small table) to the version your runtime should read
          from, fork it when you want to edit, and flip the pointer when you
          want to promote.
        </p>
        <CodeBlock
          code={`// 1. Your app remembers which version is deployed
const LIVE = await getLiveVersionFromConfig() // "v2"

// 2. Runtime reads use the live version
const runtime = new PgFileSystem({ db: sql, workspaceId, version: LIVE })
await runtime.readFile("/config.json")

// 3. Start editing in a fresh version forked from live
const draft = await runtime.fork("v3")
await draft.writeFile("/config.json", '{"env":"prod-v2"}')

// 4. When ready, flip the pointer (caller's responsibility)
await setLiveVersionInConfig("v3")`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          API Reference
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Member</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Type</th>
                <th className="py-2 font-medium text-foreground/80">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">version</td>
                <td className="py-2 pr-4 font-mono">readonly string</td>
                <td className="py-2">The version this instance is bound to</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">fork(name)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;PgFileSystem&gt;</td>
                <td className="py-2">Copy the current version into a new one and return an fs bound to it. Throws if <code className="font-mono">name</code> already exists or equals the current version.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">listVersions()</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;string[]&gt;</td>
                <td className="py-2">Distinct versions present in the workspace</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">deleteVersion(name)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;void&gt;</td>
                <td className="py-2">Drop every row for <code className="font-mono">name</code>. Throws if <code className="font-mono">name</code> equals the current version.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

    </div>
  );
}
