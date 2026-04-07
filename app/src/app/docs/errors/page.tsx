import { CodeBlock } from "@/components/code-block";

export default function ErrorsPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl md:text-4xl tracking-tighter font-semibold">
          Errors
        </h1>
        <p className="mt-3 text-muted-foreground leading-relaxed">
          BashGres uses two error classes:{" "}
          <code className="font-mono text-foreground/80">FsError</code> for
          filesystem operations and{" "}
          <code className="font-mono text-foreground/80">SqlError</code> for
          database-level errors.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">FsError</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Thrown by all filesystem operations. The error message follows the
          format{" "}
          <code className="font-mono text-foreground/80">
            CODE: operation, &apos;path&apos;
          </code>.
        </p>
        <CodeBlock
          code={`import { FsError } from "bash-gres"

try {
  await fs.readFile("/nonexistent")
} catch (e) {
  if (e instanceof FsError) {
    console.log(e.code)    // "ENOENT"
    console.log(e.op)      // "readFile"
    console.log(e.path)    // "/nonexistent"
    console.log(e.message) // "ENOENT: readFile, '/nonexistent'"
  }
}`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Error Codes
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left">
                <th className="py-2 pr-4 font-mono font-medium text-foreground/80">Code</th>
                <th className="py-2 font-medium text-foreground/80">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">ENOENT</td>
                <td className="py-2">File or directory not found</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">EISDIR</td>
                <td className="py-2">Operation invalid on a directory (e.g. readFile on a dir)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">ENOTDIR</td>
                <td className="py-2">Expected a directory but found a file</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">EEXIST</td>
                <td className="py-2">File or directory already exists</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">ENOTEMPTY</td>
                <td className="py-2">Directory not empty (rm without recursive)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">EACCES</td>
                <td className="py-2">Access denied &mdash; outside rootDir or permissions disabled</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">EPERM</td>
                <td className="py-2">Operation not permitted (e.g. hard link on a directory)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">ELOOP</td>
                <td className="py-2">Too many symlink levels (max 40)</td>
              </tr>
              <tr className="border-b border-border/30">
                <td className="py-2 pr-4 font-mono">EINVAL</td>
                <td className="py-2">Invalid argument (e.g. copy into own subdirectory)</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono">E2BIG</td>
                <td className="py-2">File too large to read (exceeds maxReadSize)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">SqlError</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Wraps PostgreSQL errors from the underlying driver. Includes the
          native error code for precise handling.
        </p>
        <CodeBlock
          code={`import { SqlError } from "bash-gres"

try {
  await fs.writeFile("/file.txt", "content")
} catch (e) {
  if (e instanceof SqlError) {
    console.log(e.code)       // PostgreSQL error code (e.g. "23505")
    console.log(e.detail)     // error detail
    console.log(e.constraint) // constraint name if applicable
    console.log(e.cause)      // original driver error
  }
}`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Common Patterns
        </h2>
        <CodeBlock
          code={`import { FsError } from "bash-gres"

// Check if file exists before reading
try {
  const content = await fs.readFile("/config.json")
} catch (e) {
  if (e instanceof FsError && e.code === "ENOENT") {
    // file doesn't exist — use default config
  }
}

// Force remove (ignore if not found)
await fs.rm("/tmp/cache", { recursive: true, force: true })

// Guard against write in read-only mode
try {
  await fs.writeFile("/protected/data.txt", "new data")
} catch (e) {
  if (e instanceof FsError && e.code === "EACCES") {
    console.error("Write permission denied")
  }
}`}
        />
      </section>
    </div>
  );
}
