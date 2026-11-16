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
          Versions
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Each instance is also scoped to a{" "}
          <code className="font-mono text-foreground/80">version</code> inside
          an active version root (default:{" "}
          <code className="font-mono text-foreground/80">&quot;main&quot;</code>
          ). The workspace root is versioned by default, and directories can be
          made independently versioned with{" "}
          <code className="font-mono text-foreground/80">mkdir(path, {"{ versioned: true }"})</code>.
          See{" "}
          <a
            href="/docs/versioning"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            Versioning
          </a>{" "}
          for the full API.
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({ db: sql, workspaceId: "app" })
await fs.mkdir("/database", { versioned: true })

const dbMain = await fs.versioned("/database")
await dbMain.writeFile("/config.json", '{"env":"staging"}')

const dbDraft = await dbMain.fork("draft")
await dbDraft.writeFile("/config.json", '{"env":"prod"}')

await dbMain.readFile("/config.json") // '{"env":"staging"}' -- untouched`}
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

// Read a byte range (useful for large files)
const chunk = await fs.readFileRange("/docs/guide.md", {
  offset: 0,
  limit: 1024,
})

// Read a line range (text files only — slicing happens in Postgres)
const { content: head, total } = await fs.readFileLines("/docs/guide.md", {
  offset: 1,
  limit: 50,
})
// content: lines 1-50 joined by "\\n", no trailing newline
// total:   total line count of the file (wc -l semantics)

// Read as binary
const buffer = await fs.readFileBuffer("/docs/image.png")`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Writing From a Base
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          When two writers edit the same file (a person in an editor and an
          agent, say), each reads it, changes it and saves. With{" "}
          <code className="font-mono text-foreground/80">writeFile</code> the second save overwrites the first.{" "}
          <code className="font-mono text-foreground/80">writeFileWithBase</code> takes the content the writer
          started from and compares it with what is stored, in one atomic
          step. If they match, the content is written. If the file changed
          meanwhile, a <code className="font-mono text-foreground/80">resolve</code> callback gets base, ours (what
          is stored) and theirs (the incoming content), and its result is
          stored. With no resolver, or one that returns{" "}
          <code className="font-mono text-foreground/80">undefined</code>, nothing is written and it throws{" "}
          <code className="font-mono text-foreground/80">FsWriteConflictError</code>.
        </p>
        <CodeBlock
          code={`import { contentHash, textMergeResolver } from "bash-gres"

const base = await fs.readFile("/report/document.md")
// ... the user edits ...
const r = await fs.writeFileWithBase("/report/document.md", edited, {
  base: { content: base },    // or { hash: contentHash(base) }, or null: "did not exist"
  resolve: textMergeResolver, // optional; the same type as merge()'s resolver
})
r.outcome // "written" | "unchanged" | "merged" | "removed"
r.hash    // hex sha256 of what is stored now (null after a removal)
r.content // the stored content, only when "merged"`}
        />
        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground leading-relaxed">
          <li>
            The base can be its hash (<code className="font-mono text-foreground/80">EntryShape.blobHash</code>, or{" "}
            <code className="font-mono text-foreground/80">contentHash(text)</code> without a read), its text, or{" "}
            <code className="font-mono text-foreground/80">null</code>. A hash is looked up in the stored blobs when
            the resolver needs the base text; if that blob is gone it throws{" "}
            <code className="font-mono text-foreground/80">FsBaseUnavailableError</code>, and you retry with the
            text.
          </li>
          <li>
            Stored content equal to the incoming content is{" "}
            <code className="font-mono text-foreground/80">&quot;unchanged&quot;</code>, without calling the resolver.
            A directory or symlink at the path is a conflict (
            <code className="font-mono text-foreground/80">reason: &quot;not-a-file&quot;</code>), never an
            overwrite. A frozen version is <code className="font-mono text-foreground/80">EPERM</code> &quot;version
            is frozen&quot;.
          </li>
          <li>
            The resolver runs inside the write&apos;s transaction with the
            version row locked: keep it quick, and do not write through another
            handle from it (that write would wait on this one). Its sides are
            the <code className="font-mono text-foreground/80">MergeSide</code> objects <code className="font-mono text-foreground/80">merge()</code>{" "}
            passes, with <code className="font-mono text-foreground/80">content: null</code> for non-UTF-8 files.
            Return <code className="font-mono text-foreground/80">{"{ content }"}</code>,{" "}
            <code className="font-mono text-foreground/80">{"{ remove: true }"}</code> or <code className="font-mono text-foreground/80">undefined</code>.
          </li>
          <li>
            Parents, size limit, node count and workspace quota behave as{" "}
            <code className="font-mono text-foreground/80">writeFile</code>&apos;s do for the same path and content;
            an overwrite keeps the file&apos;s mode.
          </li>
          <li>
            A matching base on a file the version owns costs one statement, as{" "}
            <code className="font-mono text-foreground/80">writeFile</code>&apos;s fast path does. Otherwise it locks
            the version (and any unfrozen ancestor it reads through), reads,
            resolves and writes. It works inside{" "}
            <code className="font-mono text-foreground/80">fs.transaction()</code>, on handles built from a Drizzle
            transaction, and on <code className="font-mono text-foreground/80">versioned(path)</code> handles.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Directories
        </h2>
        <CodeBlock
          code={`// Create directory (with recursive option)
await fs.mkdir("/docs/images", { recursive: true })

// Create an independent version root at a directory
await fs.mkdir("/database", { versioned: true })
const database = await fs.versioned("/database")

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
          Workspace Usage
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">getUsage()</code>{" "}
          reports workspace-wide storage usage and active-version-root logical
          usage. Pass a path to scope visible counts to a subtree. Stored blob
          bytes are deduplicated across the workspace, while logical bytes count
          the visible files and symlinks in the selected path.
        </p>
        <CodeBlock
          code={`const usage = await fs.getUsage()
const projectUsage = await fs.getUsage({ path: "/project" })

usage.logicalBytes     // visible bytes in fs.version
usage.referencedBlobBytes // deduped visible file blobs for the path
usage.storedBlobBytes  // deduplicated workspace blob bytes
usage.blobCount        // stored blob rows
usage.versions         // version labels in the active version root
usage.entryRows        // fs_entries rows in the active version root
usage.visibleNodes     // visible nodes in fs.version, including root
usage.limits           // { maxFiles, maxFileSize, maxWorkspaceBytes? }`}
        />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Configure{" "}
          <code className="font-mono text-foreground/80">maxWorkspaceBytes</code>{" "}
          to reject writes that would add a new blob beyond the workspace quota.
          Quota failures throw{" "}
          <code className="font-mono text-foreground/80">FsQuotaError</code>{" "}
          with structured fields for UI and API responses.
        </p>
        <CodeBlock
          code={`const fs = new PgFileSystem({
  db: sql,
  workspaceId: "tenant-a",
  maxWorkspaceBytes: 100 * 1024 * 1024,
})

try {
  await fs.writeFile("/large.bin", bytes)
} catch (e) {
  if (e instanceof FsQuotaError) {
    e.code            // "ENOSPC"
    e.limit           // configured maxWorkspaceBytes
    e.current         // current stored blob bytes
    e.attemptedDelta  // bytes for the new unique blob
  }
}`}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Collecting Unreferenced Blobs
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Overwriting a file or deleting a folder leaves its old content in{" "}
          <code className="font-mono text-foreground/80">fs_blobs</code> with no entry pointing at it.{" "}
          <code className="font-mono text-foreground/80">collectOrphanBlobs()</code> deletes, within the
          handle&apos;s workspace, the blobs no entry of any version
          references whose <code className="font-mono text-foreground/80">created_at</code> is older than{" "}
          <code className="font-mono text-foreground/80">minAgeMs</code>, with their chunk rows. The{" "}
          <code className="font-mono text-foreground/80">fs_chunk_embeddings</code> cache is left alone. Nothing runs
          it unless you call it.
        </p>
        <CodeBlock
          code={`const r = await fs.collectOrphanBlobs({
  minAgeMs: 60 * 60 * 1000, // only blobs first stored more than an hour ago
  batchSize: 1000,          // default 1000, max 10000
  lockTimeoutMs: 5000,      // default 5000
})
r.blobs    // deleted blobs
r.bytes    // their size_bytes
r.batches  // locked batches that ran
r.complete // false: open write transactions kept the lock; run it again later
r.pending  // unreferenced, old-enough blobs left when complete is false`}
        />
        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground leading-relaxed">
          <li>
            <code className="font-mono text-foreground/80">created_at</code> is when that exact content was first
            stored in the workspace; writing the same content again does not
            refresh it. So <code className="font-mono text-foreground/80">minAgeMs</code> protects recently created
            content, not content that stopped being referenced recently: a
            blob first stored long ago can go as soon as nothing references
            it. A <code className="font-mono text-foreground/80">writeFileWithBase</code> base named by hash can then
            be gone; retry with its text.
          </li>
          <li>
            Safe beside concurrent writes. Every write transaction holds a
            per-workspace advisory lock, shared, from its first statement to
            commit. Each batch takes it exclusive with a try-lock, which
            succeeds only while no write transaction in the workspace is open,
            then deletes in a new statement that sees every committed write.
            Writers never queue behind a collector that is waiting; one that
            arrives during a batch&apos;s DELETE waits for that DELETE. This
            assumes write transactions run at READ COMMITTED, the PostgreSQL
            default.
          </li>
          <li>
            Retries back off from 10 ms, doubling up to 250 ms, until{" "}
            <code className="font-mono text-foreground/80">lockTimeoutMs</code>. Any open write transaction blocks
            it, including one a host keeps open across slow work (a merge with
            a slow resolver, a batch import).{" "}
            <code className="font-mono text-foreground/80">{"{ blobs: 0, complete: true }"}</code> means nothing to
            collect; <code className="font-mono text-foreground/80">complete: false</code> with{" "}
            <code className="font-mono text-foreground/80">batches: 0</code> means it never got the lock, and with{" "}
            <code className="font-mono text-foreground/80">batches &gt; 0</code> it collected some, then could not
            get it again.
          </li>
          <li>
            Writers on bash-gres 3.2 or earlier do not take the lock: upgrade
            every process that writes to the workspace before the first call.
            It refuses to run inside a transaction (<code className="font-mono text-foreground/80">fs.transaction()</code>, or a
            handle built on a Drizzle transaction), and a
            read-only handle gets <code className="font-mono text-foreground/80">EPERM</code>.
          </li>
          <li>
            <code className="font-mono text-foreground/80">rm(path, {"{ deleteVersionRoot: true }"})</code>,{" "}
            <code className="font-mono text-foreground/80">deleteVersion()</code> and <code className="font-mono text-foreground/80">sweepHistory()</code>{" "}
            free their blobs themselves only when no other write transaction
            in the workspace is open; otherwise they leave them for the
            collector.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Dropping a Workspace
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <code className="font-mono text-foreground/80">dropWorkspace(db, workspaceId)</code> deletes everything
          stored for one workspace: every version root (<code className="font-mono text-foreground/80">/</code> included),
          every version (frozen, materialized and deleted-but-retained ones
          too), the ancestor closure, merge records, entries, blobs, chunks
          and cached chunk embeddings. Retention settings keep nothing. It is a
          function beside <code className="font-mono text-foreground/80">setup()</code>; each adapter exports a
          native form.
        </p>
        <CodeBlock
          code={`import { dropWorkspace } from "bash-gres/drizzle"

await db.transaction(async (tx) => {
  const removed = await dropWorkspace(tx, tenant.workspaceId, {
    statementTimeoutMs: 60_000, // default
  })
  // { versionRoots, versions, versionAncestors, versionMerges,
  //   entries, blobs, bytes, chunks, chunkEmbeddings }
  await tx.delete(tenants).where(eq(tenants.id, tenant.id))
})`}
        />
        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground leading-relaxed">
          <li>
            Runs in a transaction on <code className="font-mono text-foreground/80">db</code>: a savepoint when{" "}
            <code className="font-mono text-foreground/80">db</code> is already in one, so it commits or rolls back
            with the caller&apos;s work. A workspace that does not exist, or was
            already dropped, returns zero counts.
          </li>
          <li>
            Safe beside concurrent writes: before reading anything it takes the
            per-workspace lock writers hold shared, exclusive and blocking, and
            keeps it until the transaction ends. It waits for open write
            transactions; later ones wait behind it, then fail. Inside a
            caller&apos;s transaction, call it before writing to the workspace
            there.
          </li>
          <li>
            RLS: it sets <code className="font-mono text-foreground/80">app.workspace_id</code> and{" "}
            <code className="font-mono text-foreground/80">statement_timeout</code> for its own statements and
            restores the caller&apos;s values; a role under the policy needs only
            SELECT and DELETE on the fs tables. A transaction already scoped
            to another workspace is refused. It needs READ COMMITTED and
            throws under REPEATABLE READ or SERIALIZABLE.
          </li>
          <li>
            Handles open on the workspace afterwards read nothing (
            <code className="font-mono text-foreground/80">ENOENT</code>); their writes,{" "}
            <code className="font-mono text-foreground/80">fork()</code> and{" "}
            <code className="font-mono text-foreground/80">freeze()</code> write nothing and fail like a workspace
            never created, and the handle forgets its cached version. <code className="font-mono text-foreground/80">init()</code> recreates the workspace empty.
          </li>
        </ul>
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
