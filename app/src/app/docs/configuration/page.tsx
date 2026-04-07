import { CodeBlock } from "@/components/code-block";

export default function ConfigurationPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Configuration
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          All options for{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>,
          including limits, sandbox controls, and vector search.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          PgFileSystemOptions
        </h2>
        <CodeBlock
          code={`const fs = new PgFileSystem({
  db: sql,                            // SqlClient (required)
  workspaceId: "workspace-1",         // string (default: random UUID)

  // Limits
  maxFileSize: 10 * 1024 * 1024,      // max file size in bytes (default: 10 MB)
  maxReadSize: 5 * 1024 * 1024,       // max read size (default: unlimited)
  maxFiles: 10_000,                    // max files per workspace (default: 10,000)
  maxDepth: 50,                        // max path depth (default: 50)
  statementTimeoutMs: 5000,            // query timeout in ms (default: 5000)

  // Sandbox
  rootDir: "/",                        // root directory (default: "/")
  permissions: {
    read: true,                        // allow read operations (default: true)
    write: true,                       // allow write operations (default: true)
  },

  // Vector search
  embed: undefined,                    // embedding function (default: undefined)
  embeddingDimensions: undefined,      // expected dimensions (default: undefined)
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Full Reference
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Option</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Type</th>
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Default</th>
                <th className="py-2 font-medium text-foreground/80">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">db</td>
                <td className="py-2 pr-4 font-mono">SqlClient</td>
                <td className="py-2 pr-4 font-mono">-</td>
                <td className="py-2">Database client (required)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">workspaceId</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2 pr-4 font-mono">UUID</td>
                <td className="py-2">Workspace identifier for multi-tenant isolation</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">maxFileSize</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">10 MB</td>
                <td className="py-2">Maximum file size in bytes for writeFile/appendFile</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">maxReadSize</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">-</td>
                <td className="py-2">Maximum bytes returned by readFile (throws E2BIG if exceeded)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">maxFiles</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">10,000</td>
                <td className="py-2">Maximum files per workspace</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">maxDepth</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">50</td>
                <td className="py-2">Maximum directory nesting depth</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">statementTimeoutMs</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">5000</td>
                <td className="py-2">PostgreSQL query timeout (SET LOCAL statement_timeout)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">rootDir</td>
                <td className="py-2 pr-4 font-mono">string</td>
                <td className="py-2 pr-4 font-mono">&quot;/&quot;</td>
                <td className="py-2">Root directory - operations are sandboxed within</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">permissions</td>
                <td className="py-2 pr-4 font-mono">FsPermissions</td>
                <td className="py-2 pr-4 font-mono">{`{ read: true, write: true }`}</td>
                <td className="py-2">Enable or disable read/write operations</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">embed</td>
                <td className="py-2 pr-4 font-mono">(text: string) =&gt; Promise&lt;number[]&gt;</td>
                <td className="py-2 pr-4 font-mono">-</td>
                <td className="py-2">Embedding function for semantic search</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">embeddingDimensions</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2 pr-4 font-mono">-</td>
                <td className="py-2">Expected vector dimensions (validated on write)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Limits
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Limits protect against runaway usage. When a limit is exceeded, the
          operation throws a descriptive error.
        </p>
        <CodeBlock
          code={`// Restrict to small files and fewer total files
const fs = new PgFileSystem({
  db: sql,
  workspaceId: "sandbox",
  maxFileSize: 1024 * 1024,       // 1 MB max per file
  maxReadSize: 512 * 1024,        // 512 KB max read
  maxFiles: 1000,                 // 1,000 files per workspace
  maxDepth: 20,                   // 20 levels deep
  statementTimeoutMs: 2000,       // 2s query timeout
})`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Sandbox
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use <code className="font-mono text-foreground/80">rootDir</code> and{" "}
          <code className="font-mono text-foreground/80">permissions</code> to
          sandbox operations. Paths outside{" "}
          <code className="font-mono text-foreground/80">rootDir</code> throw{" "}
          <code className="font-mono text-foreground/80">EACCES</code>.
          Disabled permissions throw{" "}
          <code className="font-mono text-foreground/80">EACCES</code> on any
          matching operation.
        </p>
        <CodeBlock
          code={`// Read-only filesystem scoped to /data
const fs = new PgFileSystem({
  db: sql,
  workspaceId: "reader",
  rootDir: "/data",
  permissions: { read: true, write: false },
})

await fs.readFile("/data/config.json")     // OK
await fs.writeFile("/data/new.txt", "hi")  // throws EACCES
await fs.readFile("/etc/secrets")           // throws EACCES (outside rootDir)`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Vector Search
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          To enable semantic and hybrid search, provide an{" "}
          <code className="font-mono text-foreground/80">embed</code> function.
          Embeddings are automatically computed on{" "}
          <code className="font-mono text-foreground/80">writeFile</code> and{" "}
          <code className="font-mono text-foreground/80">appendFile</code> for
          text content.
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({
  db: sql,
  workspaceId: "workspace-1",
  embed: async (text) => {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    })
    return res.data[0].embedding
  },
  embeddingDimensions: 1536,
})`}
        />
      </section>
    </div>
  );
}
