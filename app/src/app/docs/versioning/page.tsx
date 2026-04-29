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
          <code className="font-mono text-foreground/80">version</code> inside an
          active version root. The default version root is{" "}
          <code className="font-mono text-foreground/80">/</code>, and any
          non-nested directory can become its own version root with{" "}
          <code className="font-mono text-foreground/80">mkdir(path, {"{ versioned: true }"})</code>.
          Versions are copy-on-write overlays, so the same path can hold
          different contents across versions without duplicating every row on
          fork.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Basic Usage
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The <code className="font-mono text-foreground/80">version</code>{" "}
          option selects which version an instance reads from and writes to in
          its active version root. If omitted, it defaults to{" "}
          <code className="font-mono text-foreground/80">&quot;main&quot;</code>.
        </p>
        <CodeBlock
          code={`// Scoped to (workspaceId, versionRoot: "/", version: "v2")
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
          Versioned Directories
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          A versioned directory is a normal directory with an independent
          version graph, similar to running <code className="font-mono text-foreground/80">git init</code>{" "}
          inside it. Use <code className="font-mono text-foreground/80">versioned(path)</code>{" "}
          to open a scoped facade; paths on that facade are relative to the
          versioned directory.
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({ db: sql, workspaceId: "workspace-1" })
await fs.init()

await fs.mkdir("/database", { versioned: true })

const dbMain = await fs.versioned("/database")
await dbMain.writeFile("/schema.sql", "main")

const dbDraft = await dbMain.fork("draft")
await dbDraft.writeFile("/schema.sql", "draft")

await dbMain.readFile("/schema.sql")  // "main"
await dbDraft.readFile("/schema.sql") // "draft"
await dbMain.versionRoot               // "/database"`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Version labels are scoped to the version root, so{" "}
          <code className="font-mono text-foreground/80">/database</code> and{" "}
          <code className="font-mono text-foreground/80">/user</code> can both
          have a <code className="font-mono text-foreground/80">draft</code>{" "}
          version. Nested versioned directories are rejected.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Fork
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">fork(name)</code>{" "}
          creates an O(1) child version and returns a{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          bound to it. No entry rows are copied. Reads fall through to the
          nearest ancestor row until the child writes or deletes that path.
        </p>
        <CodeBlock
          code={`const v1 = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  version: "v1",
})

await v1.writeFile("/src/app.ts", "export default 1;")
await v1.writeFile("/readme.md", "# v1")

// Fork: link v1 -> v2, return an fs bound to v2
const v2 = await v1.fork("v2")

await v2.writeFile("/readme.md", "# v2 modified")

await v1.readFile("/readme.md") // "# v1"        (unchanged)
await v2.readFile("/readme.md") // "# v2 modified"`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          This is a live ancestor overlay, not a historical snapshot. If a
          parent changes after a child is forked, the child can still see that
          change for paths it has not shadowed. Call{" "}
          <code className="font-mono text-foreground/80">detach()</code> when
          you need a standalone checkpoint.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          List & Delete
        </h2>
        <CodeBlock
          code={`// All versions present in the active version root
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
          <code className="font-mono text-foreground/80">diff()</code> compares
          the current visible tree to another version and returns changed paths
          with before/after entry metadata. Use{" "}
          <code className="font-mono text-foreground/80">diffStream()</code> for
          keyset-paginated iteration over large trees.
        </p>
        <CodeBlock
          code={`const changes = await v2.diff("v1", { path: "/src" })
// [{ path: "/src/app.ts", change: "modified", before, after }]

for await (const change of v2.diffStream("v1", { batchSize: 500 })) {
  console.log(change.path, change.change)
}`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Merge, Cherry-Pick & Revert
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">merge()</code> applies
          changes from another version into the current one using a three-way
          comparison against the lowest common ancestor. Conflicts fail by
          default, or you can resolve them with{" "}
          <code className="font-mono text-foreground/80">strategy</code>.
        </p>
        <CodeBlock
          code={`const result = await draft.merge("feature", {
  strategy: "fail",      // "fail" | "ours" | "theirs"
  pathScope: "/src",
  dryRun: true,
})

if (result.conflicts.length === 0) {
  await draft.merge("feature", { pathScope: "/src" })
}

// Source-wins copy for selected paths, without LCA conflict checks.
await draft.cherryPick("feature", ["/src/router.ts", "/docs"])

// Restore selected paths to match another version.
await draft.revert("live", { paths: ["/config.json"] })`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Detach & Rename
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">detach()</code>{" "}
          materializes the current visible tree into the current version and
          severs ancestor dependencies. Use{" "}
          <code className="font-mono text-foreground/80">renameVersion()</code>{" "}
          to move labels, or{" "}
          <code className="font-mono text-foreground/80">promoteTo()</code> for
          the common detach-and-swap deploy flow.
        </p>
        <CodeBlock
          code={`// Freeze draft as an independent snapshot.
await draft.detach()

// Rename this version. With swap, an existing label is displaced.
const renamed = await draft.renameVersion("release-2026-04-28", {
  swap: true,
})

// Deploy helper: detach -> renameVersion(label, { swap: true })
const promoted = await draft.promoteTo("live", {
  dropPrevious: false,
})
// { label: "live", displacedLabel: "live-prev-..." }`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Deploy Pattern
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          BashGres exposes versions as data. You can keep the live pointer in
          your own config, or reserve a label like{" "}
          <code className="font-mono text-foreground/80">live</code> and use
          <code className="font-mono text-foreground/80"> promoteTo()</code> to
          atomically move that label to a detached draft. For a versioned
          directory, do this through its scoped facade.
        </p>
        <CodeBlock
          code={`// 1. Runtime reads use the live label inside /database
const runtime = await fs.versioned("/database", { version: "live" })
await runtime.readFile("/config.json")

// 2. Start editing in a fresh version forked from live
const draft = await runtime.fork("v3")
await draft.writeFile("/config.json", '{"env":"prod-v2"}')

// 3. Promote by detaching the draft and swapping the live label
await draft.promoteTo("live")`}
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
                <td className="py-2 pr-4 font-mono">versionRoot</td>
                <td className="py-2 pr-4 font-mono">readonly string</td>
                <td className="py-2">Absolute workspace path that owns this instance&apos;s version graph.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">versioned(path, opts?)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;PgFileSystem&gt;</td>
                <td className="py-2">Open a scoped facade for a versioned directory. Throws <code className="font-mono">ENOTVERSIONED</code> for normal directories.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">fork(name)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;PgFileSystem&gt;</td>
                <td className="py-2">Create an O(1) child overlay and return an fs bound to it. Throws if <code className="font-mono">name</code> already exists or equals the current version.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">diff(other, opts?)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;VersionDiffEntry[]&gt;</td>
                <td className="py-2">Compare this visible tree to another version, optionally scoped to a path.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">diffStream(other, opts?)</td>
                <td className="py-2 pr-4 font-mono">AsyncIterable&lt;VersionDiffEntry&gt;</td>
                <td className="py-2">Stream the same diff with keyset pagination for large trees.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">merge(source, opts?)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;MergeResult&gt;</td>
                <td className="py-2">Three-way merge from a source version into the current version.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">cherryPick(source, paths)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;MergeResult&gt;</td>
                <td className="py-2">Source-wins copy of selected paths without LCA conflict checks.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">revert(target, opts?)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;MergeResult&gt;</td>
                <td className="py-2">Restore selected paths in the current version to match a target version.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">detach()</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;void&gt;</td>
                <td className="py-2">Materialize visible entries and sever ancestor dependencies.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">renameVersion(label, opts?)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;RenameVersionResult&gt;</td>
                <td className="py-2">Rename this version label, optionally displacing an existing label with <code className="font-mono">swap</code>.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">promoteTo(label, opts?)</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;PromoteResult&gt;</td>
                <td className="py-2">Detach, swap this version onto a label, and optionally drop the previous holder.</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">listVersions()</td>
                <td className="py-2 pr-4 font-mono">Promise&lt;string[]&gt;</td>
                <td className="py-2">Distinct versions present in the active version root</td>
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
