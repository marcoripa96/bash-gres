import { CodeBlock } from "@/components/code-block";

export default function FilesystemPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Filesystem
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          mirrors the Node.js{" "}
          <code className="font-mono text-foreground/80">fs</code> API. All
          operations are transactional, scoped to a workspace, and subject to
          configurable limits.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Workspace Isolation
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every{" "}
          <code className="font-mono text-foreground/80">PgFileSystem</code>{" "}
          instance is scoped to a workspace. Workspaces are isolated via
          PostgreSQL Row-Level Security. Each transaction sets{" "}
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
await ws2.exists("/data.txt") // false, different workspace`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Reading & Writing
        </h2>
        <CodeBlock
          code={`// Write a text file (creates parent directories automatically)
await fs.writeFile("/docs/guide.md", "# Getting Started")

// Append to a file (creates if missing)
await fs.appendFile("/docs/guide.md", "\\nMore content...")

// Read entire file as string
const content = await fs.readFile("/docs/guide.md")

// Read a range (useful for large files)
const chunk = await fs.readFileRange("/docs/guide.md", {
  offset: 0,
  limit: 1024,
})

// Read as binary
const buffer = await fs.readFileBuffer("/docs/image.png")`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Directories
        </h2>
        <CodeBlock
          code={`// Create directory (with recursive option)
await fs.mkdir("/docs/images", { recursive: true })

// List directory names
const names = await fs.readdir("/docs")
// ["guide.md", "images"]

// List with type info (avoids extra stat calls)
const entries = await fs.readdirWithFileTypes("/docs")
// [{ name: "guide.md", isFile: true, isDirectory: false, isSymbolicLink: false }, ...]

// List with full stat info
const detailed = await fs.readdirWithStats("/docs")
// [{ name, isFile, isDirectory, isSymbolicLink, mode, size, mtime, symlinkTarget }, ...]

// Walk entire directory tree recursively
const tree = await fs.walk("/docs")
// [{ path: "/docs/guide.md", name: "guide.md", depth: 1, isFile: true, ... }, ...]`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Copy, Move, Remove
        </h2>
        <CodeBlock
          code={`// Copy file or directory
await fs.cp("/docs", "/backup", { recursive: true })

// Move / rename
await fs.mv("/backup/guide.md", "/archive/guide.md")

// Remove file
await fs.rm("/archive/guide.md")

// Remove directory recursively (force ignores ENOENT)
await fs.rm("/archive", { recursive: true, force: true })`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Stat & Existence
        </h2>
        <CodeBlock
          code={`// Check existence
const exists = await fs.exists("/docs/guide.md")

// Get file stats (follows symlinks)
const stat = await fs.stat("/docs/guide.md")
// { isFile: true, isDirectory: false, isSymbolicLink: false,
//   mode: 420, size: 18, mtime: Date }

// Get stats without following symlinks
const lstat = await fs.lstat("/link")

// Resolve symlinks to canonical path
const real = await fs.realpath("/link")`}
        />
        <h3 className="text-base font-semibold tracking-tight mt-6">FsStat</h3>
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
                <td className="py-2 pr-4 font-mono">isFile</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2">True if regular file</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">isDirectory</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2">True if directory</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">isSymbolicLink</td>
                <td className="py-2 pr-4 font-mono">boolean</td>
                <td className="py-2">True if symlink (only from lstat)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">mode</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">Unix permission bits (default: 0o644)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">size</td>
                <td className="py-2 pr-4 font-mono">number</td>
                <td className="py-2">File size in bytes</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">mtime</td>
                <td className="py-2 pr-4 font-mono">Date</td>
                <td className="py-2">Last modified time</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Symlinks & Links
        </h2>
        <CodeBlock
          code={`// Create symbolic link
await fs.symlink("/docs/guide.md", "/latest")

// Read symlink target
const target = await fs.readlink("/latest")
// "/docs/guide.md"

// Create hard link (copies content, shares no reference)
await fs.link("/docs/guide.md", "/docs/guide-copy.md")`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Symlinks are resolved up to 40 levels deep before throwing{" "}
          <code className="font-mono text-foreground/80">ELOOP</code>.
          Symlink targets are limited to 4096 characters.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Permissions & Timestamps
        </h2>
        <CodeBlock
          code={`// Change file permissions
await fs.chmod("/docs/guide.md", 0o755)

// Update modification time
await fs.utimes("/docs/guide.md", new Date(), new Date())`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Glob
        </h2>
        <CodeBlock
          code={`// Match files using glob patterns
const tsFiles = await fs.glob("**/*.ts", { cwd: "/project/src" })
// ["/project/src/index.ts", "/project/src/utils/helpers.ts"]`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Path Resolution
        </h2>
        <CodeBlock
          code={`// Resolve relative paths
fs.resolvePath("/docs", "../images/logo.png")
// "/images/logo.png"

fs.resolvePath("/docs", "./guide.md")
// "/docs/guide.md"`}
        />
      </section>

    </div>
  );
}
