import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { BashInterpreter } from "../lib/core/bash/interpreter.js";
import type { SqlClient } from "./helpers.js";

/**
 * Integration tests that simulate real-world task completion via bash commands.
 * Each task creates files, reads them back, and searches for content —
 * exercising the full bash-gres stack as an AI agent would use it.
 */

describe.each(TEST_ADAPTERS)("Bash task scenarios [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;
  let bash: BashInterpreter;

  /** Helper: execute and assert success */
  async function run(cmd: string) {
    const r = await bash.execute(cmd);
    expect(r.exitCode, `Command failed: ${cmd}\nstderr: ${r.stderr}`).toBe(0);
    return r;
  }

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await client.query(
      "DELETE FROM fs_nodes WHERE workspace_id = $1",
      ["task-test"],
    );
    fs = new PgFileSystem({ db: client, workspaceId: "task-test" });
    await fs.init();
    bash = new BashInterpreter(fs);
  });

  // ---------------------------------------------------------------------------
  // Task 1: Scaffold a Node.js project
  // ---------------------------------------------------------------------------
  describe("Task 1: Scaffold a Node.js project", () => {
    it("creates project structure, writes config files, and verifies with tree", async () => {
      // Create directory structure
      await run("mkdir -p /myapp/src/routes");
      await run("mkdir -p /myapp/src/utils");
      await run("mkdir -p /myapp/tests");
      await run("mkdir -p /myapp/config");

      // Write package.json
      await run('echo "{\n  \\"name\\": \\"myapp\\",\n  \\"version\\": \\"1.0.0\\",\n  \\"main\\": \\"src/index.ts\\",\n  \\"scripts\\": {\n    \\"start\\": \\"node dist/index.js\\",\n    \\"build\\": \\"tsc\\",\n    \\"test\\": \\"vitest run\\"\n  },\n  \\"dependencies\\": {\n    \\"express\\": \\"^4.18.0\\",\n    \\"zod\\": \\"^3.22.0\\"\n  }\n}" > /myapp/package.json');

      // Write tsconfig.json
      await run('echo "{\n  \\"compilerOptions\\": {\n    \\"target\\": \\"ES2022\\",\n    \\"module\\": \\"NodeNext\\",\n    \\"outDir\\": \\"dist\\",\n    \\"strict\\": true\n  },\n  \\"include\\": [\\"src\\"]\n}" > /myapp/tsconfig.json');

      // Write source files
      await run('echo "import express from \\"express\\";\nimport { healthRouter } from \\"./routes/health.js\\";\n\nconst app = express();\napp.use(\\"/health\\", healthRouter);\napp.listen(3000, () => console.log(\\"Server started on port 3000\\"));" > /myapp/src/index.ts');

      await run('echo "import { Router } from \\"express\\";\n\nexport const healthRouter = Router();\nhealthRouter.get(\\"/\\", (_req, res) => {\n  res.json({ status: \\"ok\\", uptime: process.uptime() });\n});" > /myapp/src/routes/health.ts');

      await run('echo "export function slugify(text: string): string {\n  return text.toLowerCase().replace(/\\\\s+/g, \\"-\\").replace(/[^a-z0-9-]/g, \\"\\");\n}\n\nexport function truncate(text: string, maxLen: number): string {\n  if (text.length <= maxLen) return text;\n  return text.slice(0, maxLen - 3) + \\"...\\";\n}" > /myapp/src/utils/strings.ts');

      // Write a test file
      await run('echo "import { describe, it, expect } from \\"vitest\\";\nimport { slugify, truncate } from \\"../src/utils/strings.js\\";\n\ndescribe(\\"strings\\", () => {\n  it(\\"slugifies text\\", () => {\n    expect(slugify(\\"Hello World\\")).toBe(\\"hello-world\\");\n  });\n  it(\\"truncates long text\\", () => {\n    expect(truncate(\\"abcdef\\", 5)).toBe(\\"ab...\\");\n  });\n});" > /myapp/tests/strings.test.ts');

      // Verify: tree shows full structure
      const tree = await run("tree /myapp");
      expect(tree.stdout).toContain("src/");
      expect(tree.stdout).toContain("routes/");
      expect(tree.stdout).toContain("utils/");
      expect(tree.stdout).toContain("tests/");
      expect(tree.stdout).toContain("config/");
      expect(tree.stdout).toContain("package.json");
      expect(tree.stdout).toContain("tsconfig.json");
      expect(tree.stdout).toContain("index.ts");
      expect(tree.stdout).toContain("health.ts");
      expect(tree.stdout).toContain("strings.ts");
      expect(tree.stdout).toContain("strings.test.ts");

      // Verify: cat reads back correct content
      const pkg = await run("cat /myapp/package.json");
      expect(pkg.stdout).toContain('"name": "myapp"');
      expect(pkg.stdout).toContain('"express"');

      const index = await run("cat /myapp/src/index.ts");
      expect(index.stdout).toContain("import express");
      expect(index.stdout).toContain("app.listen(3000");

      // Verify: find locates all TypeScript files
      const tsFiles = await run("find /myapp -name *.ts");
      expect(tsFiles.stdout).toContain("index.ts");
      expect(tsFiles.stdout).toContain("health.ts");
      expect(tsFiles.stdout).toContain("strings.ts");
      expect(tsFiles.stdout).toContain("strings.test.ts");

      // Verify: grep finds imports across files
      const imports = await run("grep -r import /myapp/src");
      expect(imports.stdout).toContain("express");
      expect(imports.stdout).toContain("Router");

      // Verify: find -type d shows only directories
      const dirs = await run("find /myapp -type d");
      expect(dirs.stdout).toContain("/myapp/src");
      expect(dirs.stdout).toContain("/myapp/src/routes");
      expect(dirs.stdout).toContain("/myapp/tests");
      expect(dirs.stdout).not.toContain("index.ts");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 2: Write and manage a TODO list
  // ---------------------------------------------------------------------------
  describe("Task 2: Write and manage a TODO list", () => {
    it("creates, updates, searches, and reorganizes notes", async () => {
      await run("mkdir -p /notes");

      // Create a TODO list
      await run('echo "# TODO List\n- [ ] Buy groceries\n- [ ] Fix login bug\n- [ ] Write unit tests\n- [ ] Review pull request #42\n- [ ] Deploy to staging" > /notes/todo.md');

      // Read it back
      const todo = await run("cat /notes/todo.md");
      expect(todo.stdout).toContain("Buy groceries");
      expect(todo.stdout).toContain("Fix login bug");

      // Count items
      const wc = await run("wc -l /notes/todo.md");
      expect(wc.stdout).toContain("6"); // header + 5 items

      // Show first 3 lines (header + 2 items)
      const top = await run("head -n 3 /notes/todo.md");
      expect(top.stdout).toContain("# TODO List");
      expect(top.stdout).toContain("Buy groceries");
      expect(top.stdout).toContain("Fix login bug");

      // Append new items
      await run('echo "- [ ] Update documentation" >> /notes/todo.md');
      await run('echo "- [ ] Set up CI pipeline" >> /notes/todo.md');

      // Verify items were appended
      const updated = await run("cat /notes/todo.md");
      expect(updated.stdout).toContain("Update documentation");
      expect(updated.stdout).toContain("Set up CI pipeline");

      // Tail to see the last 3 items
      const last = await run("tail -n 3 /notes/todo.md");
      expect(last.stdout).toContain("Deploy to staging");
      expect(last.stdout).toContain("Update documentation");
      expect(last.stdout).toContain("Set up CI pipeline");

      // Create a second note file with meeting notes
      await run('echo "# Meeting Notes 2024-01-15\n\nAttendees: Alice, Bob, Charlie\n\n## Decisions\n- Deploy v2.0 by Friday\n- Fix login bug is P0 priority\n- Charlie to review pull request #42\n\n## Action Items\n- Bob: update documentation\n- Alice: set up CI pipeline" > /notes/meeting.md');

      // Search across all notes for "login bug"
      const grepBug = await run("grep -r login /notes");
      expect(grepBug.stdout).toContain("/notes/todo.md");
      expect(grepBug.stdout).toContain("/notes/meeting.md");

      // Search for pull request references
      const grepPR = await run("grep -rn pull /notes");
      expect(grepPR.stdout).toContain("pull request #42");
      // Should appear in both files with line numbers
      expect(grepPR.stdout).toContain("/notes/todo.md:");
      expect(grepPR.stdout).toContain("/notes/meeting.md:");

      // List all .md files
      const mdFiles = await run("find /notes -name *.md");
      const fileList = mdFiles.stdout.trim().split("\n");
      expect(fileList).toHaveLength(2);
      expect(mdFiles.stdout).toContain("todo.md");
      expect(mdFiles.stdout).toContain("meeting.md");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 3: Build a configuration system
  // ---------------------------------------------------------------------------
  describe("Task 3: Build a configuration system", () => {
    it("creates env-specific configs, copies defaults, and diffs them via grep", async () => {
      await run("mkdir -p /app/config");

      // Write default config
      await run('echo "DATABASE_HOST=localhost\nDATABASE_PORT=5432\nDATABASE_NAME=myapp_dev\nREDIS_URL=redis://localhost:6379\nLOG_LEVEL=debug\nAPI_KEY=dev-key-12345\nMAX_CONNECTIONS=10\nENABLE_CACHE=true" > /app/config/default.env');

      // Copy to create staging config
      await run("cp /app/config/default.env /app/config/staging.env");

      // Copy to create production config
      await run("cp /app/config/default.env /app/config/production.env");

      // Overwrite staging with adjusted values
      await run('echo "DATABASE_HOST=staging-db.internal\nDATABASE_PORT=5432\nDATABASE_NAME=myapp_staging\nREDIS_URL=redis://staging-redis.internal:6379\nLOG_LEVEL=info\nAPI_KEY=staging-key-67890\nMAX_CONNECTIONS=50\nENABLE_CACHE=true" > /app/config/staging.env');

      // Overwrite production with adjusted values
      await run('echo "DATABASE_HOST=prod-db.internal\nDATABASE_PORT=5432\nDATABASE_NAME=myapp_prod\nREDIS_URL=redis://prod-redis.internal:6379\nLOG_LEVEL=warn\nAPI_KEY=prod-key-SECURE\nMAX_CONNECTIONS=200\nENABLE_CACHE=true" > /app/config/production.env');

      // Verify all configs exist
      const configs = await run("ls /app/config");
      expect(configs.stdout).toContain("default.env");
      expect(configs.stdout).toContain("staging.env");
      expect(configs.stdout).toContain("production.env");

      // Read each config back
      const dev = await run("cat /app/config/default.env");
      expect(dev.stdout).toContain("DATABASE_HOST=localhost");
      expect(dev.stdout).toContain("LOG_LEVEL=debug");

      const staging = await run("cat /app/config/staging.env");
      expect(staging.stdout).toContain("DATABASE_HOST=staging-db.internal");
      expect(staging.stdout).toContain("LOG_LEVEL=info");

      const prod = await run("cat /app/config/production.env");
      expect(prod.stdout).toContain("DATABASE_HOST=prod-db.internal");
      expect(prod.stdout).toContain("LOG_LEVEL=warn");
      expect(prod.stdout).toContain("MAX_CONNECTIONS=200");

      // Search for all DATABASE_HOST values across configs
      const hosts = await run("grep DATABASE_HOST /app/config/default.env /app/config/staging.env /app/config/production.env");
      expect(hosts.stdout).toContain("localhost");
      expect(hosts.stdout).toContain("staging-db.internal");
      expect(hosts.stdout).toContain("prod-db.internal");

      // Search for LOG_LEVEL across all configs
      const logLevels = await run("grep -r LOG_LEVEL /app/config");
      expect(logLevels.stdout).toContain("debug");
      expect(logLevels.stdout).toContain("info");
      expect(logLevels.stdout).toContain("warn");

      // Count lines in each config (should all be 8)
      const wcDev = await run("wc -l /app/config/default.env");
      expect(wcDev.stdout).toContain("8");
      const wcProd = await run("wc -l /app/config/production.env");
      expect(wcProd.stdout).toContain("8");

      // Pipe: show only database-related config for production
      const dbProd = await run("cat /app/config/production.env | grep DATABASE");
      expect(dbProd.stdout).toContain("DATABASE_HOST=prod-db.internal");
      expect(dbProd.stdout).toContain("DATABASE_PORT=5432");
      expect(dbProd.stdout).toContain("DATABASE_NAME=myapp_prod");
      expect(dbProd.stdout).not.toContain("REDIS");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 4: Write a multi-file blog with cross-references
  // ---------------------------------------------------------------------------
  describe("Task 4: Write a multi-file blog with cross-references", () => {
    it("creates posts, indexes them, and searches for cross-references", async () => {
      await run("mkdir -p /blog/posts");
      await run("mkdir -p /blog/drafts");

      // Write blog posts
      await run('echo "# Getting Started with TypeScript\n\nTypeScript adds static types to JavaScript.\nSee also: [Advanced Patterns](/blog/posts/advanced-patterns.md)\n\n## Why TypeScript?\n- Catch bugs at compile time\n- Better IDE support\n- Self-documenting code\n\nTags: typescript, beginner, tutorial" > /blog/posts/getting-started.md');

      await run('echo "# Advanced TypeScript Patterns\n\nBuilding on [Getting Started](/blog/posts/getting-started.md),\nthis post covers advanced patterns.\n\n## Discriminated Unions\ntype Shape =\n  | { kind: \\"circle\\"; radius: number }\n  | { kind: \\"square\\"; side: number }\n\n## Template Literal Types\ntype EventName = `on${string}`\n\nSee also: [Error Handling](/blog/posts/error-handling.md)\n\nTags: typescript, advanced, patterns" > /blog/posts/advanced-patterns.md');

      await run('echo "# Error Handling in TypeScript\n\nProper error handling is crucial.\nRelated: [Advanced Patterns](/blog/posts/advanced-patterns.md)\n\n## Result Type\ntype Result<T, E> = { ok: true; value: T } | { ok: false; error: E }\n\n## Using neverthrow\nimport { ok, err, Result } from \\"neverthrow\\";\n\nTags: typescript, error-handling, patterns" > /blog/posts/error-handling.md');

      // Write a draft
      await run('echo "# WIP: Testing Strategies\n\nDRAFT - not ready for publication\n\nUnit testing with vitest...\n\nTags: typescript, testing, draft" > /blog/drafts/testing.md');

      // Create an index file
      await run('echo "# Blog Index\n\n1. [Getting Started](posts/getting-started.md)\n2. [Advanced Patterns](posts/advanced-patterns.md)\n3. [Error Handling](posts/error-handling.md)\n\nDrafts: 1" > /blog/index.md');

      // Verify structure
      const tree = await run("tree /blog");
      expect(tree.stdout).toContain("posts/");
      expect(tree.stdout).toContain("drafts/");
      expect(tree.stdout).toContain("index.md");

      // Find all .md files
      const allMd = await run("find /blog -name *.md");
      const mdList = allMd.stdout.trim().split("\n");
      expect(mdList).toHaveLength(5); // 3 posts + 1 draft + 1 index

      // Search for cross-references (posts linking to each other)
      const refs = await run("grep -rn See /blog/posts");
      expect(refs.stdout).toContain("getting-started.md");
      expect(refs.stdout).toContain("advanced-patterns.md");
      expect(refs.stdout).toContain("error-handling.md");

      // Search for all posts tagged with "patterns"
      const patternsTag = await run("grep -r patterns /blog/posts");
      expect(patternsTag.stdout).toContain("advanced-patterns.md");
      expect(patternsTag.stdout).toContain("error-handling.md");

      // Verify draft content
      const draft = await run("cat /blog/drafts/testing.md");
      expect(draft.stdout).toContain("DRAFT");
      expect(draft.stdout).toContain("vitest");

      // Search for all "typescript" tagged posts
      const tsPosts = await run("grep -r typescript /blog");
      const tsLines = tsPosts.stdout.trim().split("\n");
      // All 4 content files mention typescript
      expect(tsLines.length).toBeGreaterThanOrEqual(4);

      // Find only files (not directories)
      const filesOnly = await run("find /blog -type f");
      const filesList = filesOnly.stdout.trim().split("\n");
      expect(filesList).toHaveLength(5);

      // Read back a specific post and verify full content integrity
      const post = await run("cat /blog/posts/advanced-patterns.md");
      expect(post.stdout).toContain("Discriminated Unions");
      expect(post.stdout).toContain("Template Literal Types");
      expect(post.stdout).toContain("Getting Started");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 5: Simulate a deployment log system
  // ---------------------------------------------------------------------------
  describe("Task 5: Simulate a deployment log system", () => {
    it("writes logs, tails recent entries, and greps for errors", async () => {
      await run("mkdir -p /var/log/deploys");

      // Write deploy log entries (simulating sequential deployments)
      await run('echo "[2024-01-10 09:00:00] INFO  Deploy started: v1.0.0\n[2024-01-10 09:01:00] INFO  Building Docker image...\n[2024-01-10 09:03:00] INFO  Running database migrations...\n[2024-01-10 09:04:00] INFO  Health check passed\n[2024-01-10 09:04:30] INFO  Deploy completed: v1.0.0 SUCCESS" > /var/log/deploys/deploy-001.log');

      await run('echo "[2024-01-12 14:00:00] INFO  Deploy started: v1.1.0\n[2024-01-12 14:01:00] INFO  Building Docker image...\n[2024-01-12 14:02:00] ERROR Connection refused: database migration failed\n[2024-01-12 14:02:30] WARN  Rolling back to v1.0.0\n[2024-01-12 14:03:00] INFO  Rollback completed\n[2024-01-12 14:03:00] INFO  Deploy completed: v1.1.0 FAILED" > /var/log/deploys/deploy-002.log');

      await run('echo "[2024-01-13 10:00:00] INFO  Deploy started: v1.1.1\n[2024-01-13 10:01:00] INFO  Building Docker image...\n[2024-01-13 10:02:00] INFO  Running database migrations...\n[2024-01-13 10:03:00] WARN  Slow query detected during migration (2.3s)\n[2024-01-13 10:04:00] INFO  Health check passed\n[2024-01-13 10:04:30] INFO  Deploy completed: v1.1.1 SUCCESS" > /var/log/deploys/deploy-003.log');

      // List all logs
      const logs = await run("ls /var/log/deploys");
      expect(logs.stdout.trim().split("\n")).toHaveLength(3);

      // Find all ERROR entries across all deploy logs
      const errors = await run("grep -rn ERROR /var/log/deploys");
      expect(errors.stdout).toContain("deploy-002.log");
      expect(errors.stdout).toContain("Connection refused");
      // Only deploy-002 has errors
      expect(errors.stdout).not.toContain("deploy-001.log");
      expect(errors.stdout).not.toContain("deploy-003.log");

      // Find all WARN entries
      const warns = await run("grep -r WARN /var/log/deploys");
      expect(warns.stdout).toContain("Rolling back");
      expect(warns.stdout).toContain("Slow query");

      // Tail the latest deploy log
      const latest = await run("tail -n 3 /var/log/deploys/deploy-003.log");
      expect(latest.stdout).toContain("Slow query");
      expect(latest.stdout).toContain("Health check passed");
      expect(latest.stdout).toContain("SUCCESS");

      // Pipe: find all FAILED deploys
      const failed = await run("grep -r FAILED /var/log/deploys");
      expect(failed.stdout).toContain("v1.1.0 FAILED");
      expect(failed.stdout).not.toContain("v1.0.0");

      // Pipe: find all SUCCESS deploys
      const success = await run("grep -r SUCCESS /var/log/deploys");
      expect(success.stdout).toContain("v1.0.0 SUCCESS");
      expect(success.stdout).toContain("v1.1.1 SUCCESS");

      // Stat a log file
      const stat = await run("stat /var/log/deploys/deploy-002.log");
      expect(stat.stdout).toContain("regular file");

      // Head: show first 2 lines of the failed deploy
      const failHead = await run("head -n 2 /var/log/deploys/deploy-002.log");
      expect(failHead.stdout).toContain("Deploy started: v1.1.0");
      expect(failHead.stdout).toContain("Building Docker image");

      // Wc: count lines in each log
      const wc1 = await run("wc -l /var/log/deploys/deploy-001.log");
      expect(wc1.stdout).toContain("5");
      const wc2 = await run("wc -l /var/log/deploys/deploy-002.log");
      expect(wc2.stdout).toContain("6");

      // Pipe: grep + wc to count how many lines mention "migration"
      // deploy-001: "Running database migrations...", deploy-002: "database migration failed",
      // deploy-003: "Running database migrations..." + "Slow query detected during migration"
      const migrationCount = await run("grep -r migration /var/log/deploys | wc -l");
      expect(migrationCount.stdout.trim()).toContain("4");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 6: Organize files with mv, cp, rm, and symlinks
  // ---------------------------------------------------------------------------
  describe("Task 6: Organize files with mv, cp, rm, and symlinks", () => {
    it("restructures a project using move, copy, delete, and symlinks", async () => {
      // Start with a messy flat structure
      await run("mkdir -p /project");
      await run('echo "body { margin: 0; }" > /project/styles.css');
      await run('echo "console.log(\\"app\\");" > /project/app.js');
      await run('echo "console.log(\\"utils\\");" > /project/utils.js');
      await run('echo "<html><body>Hello</body></html>" > /project/index.html');
      await run('echo "# My Project\nA sample project." > /project/README.md');
      await run('echo "temp data to delete" > /project/temp.log');
      await run('echo "old backup" > /project/backup.bak');

      // Organize: create proper directories
      await run("mkdir -p /project/src");
      await run("mkdir -p /project/public");
      await run("mkdir -p /project/docs");

      // Move files to proper locations
      await run("mv /project/app.js /project/src/app.js");
      await run("mv /project/utils.js /project/src/utils.js");
      await run("mv /project/styles.css /project/public/styles.css");
      await run("mv /project/index.html /project/public/index.html");
      await run("mv /project/README.md /project/docs/README.md");

      // Remove temp files
      await run("rm /project/temp.log");
      await run("rm /project/backup.bak");

      // Copy README to project root as well
      await run("cp /project/docs/README.md /project/README.md");

      // Create a symlink from public/app.js -> src/app.js
      await run("ln -s /project/src/app.js /project/public/app.js");

      // Verify: temp files are gone
      const list = await run("ls /project");
      expect(list.stdout).not.toContain("temp.log");
      expect(list.stdout).not.toContain("backup.bak");

      // Verify: files moved correctly
      const src = await run("ls /project/src");
      expect(src.stdout).toContain("app.js");
      expect(src.stdout).toContain("utils.js");

      const pub = await run("ls /project/public");
      expect(pub.stdout).toContain("styles.css");
      expect(pub.stdout).toContain("index.html");
      expect(pub.stdout).toContain("app.js"); // symlink

      // Verify: README exists in both locations
      const rootReadme = await run("cat /project/README.md");
      expect(rootReadme.stdout).toContain("My Project");
      const docsReadme = await run("cat /project/docs/README.md");
      expect(docsReadme.stdout).toContain("My Project");

      // Verify: symlink resolves
      const link = await run("readlink /project/public/app.js");
      expect(link.stdout.trim()).toBe("/project/src/app.js");

      // Verify: final tree structure
      const tree = await run("tree /project");
      expect(tree.stdout).toContain("src/");
      expect(tree.stdout).toContain("public/");
      expect(tree.stdout).toContain("docs/");

      // Verify symlink via ls -l on the directory (lstat is used for dir listings)
      const pubLs = await run("ls -l /project/public");
      // The symlink entry should start with 'l' type prefix
      const appLine = pubLs.stdout.split("\n").find((l) => l.includes("app.js"));
      expect(appLine).toBeDefined();
      expect(appLine).toMatch(/^l/);

      // Grep across the organized project
      const consoleUses = await run("grep -r console /project/src");
      expect(consoleUses.stdout).toContain("app.js");
      expect(consoleUses.stdout).toContain("utils.js");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 7: Pipe-heavy data processing
  // ---------------------------------------------------------------------------
  describe("Task 7: Pipe-heavy data processing", () => {
    it("chains pipes to filter and process data", async () => {
      await run("mkdir -p /data");

      // Write a CSV-like data file
      await run('echo "name,role,team,status\nAlice,engineer,platform,active\nBob,designer,product,active\nCharlie,engineer,platform,inactive\nDiana,pm,product,active\nEve,engineer,infra,active\nFrank,designer,product,inactive\nGrace,engineer,platform,active\nHank,pm,infra,active" > /data/employees.csv');

      // Pipe: find all engineers
      const engineers = await run("cat /data/employees.csv | grep engineer");
      expect(engineers.stdout).toContain("Alice");
      expect(engineers.stdout).toContain("Charlie");
      expect(engineers.stdout).toContain("Eve");
      expect(engineers.stdout).toContain("Grace");
      expect(engineers.stdout).not.toContain("Bob");
      expect(engineers.stdout).not.toContain("Diana");

      // Pipe: find inactive members of the platform team
      const inactivePlatform = await run("cat /data/employees.csv | grep platform | grep inactive");
      expect(inactivePlatform.stdout).toContain("Charlie");
      expect(inactivePlatform.stdout).not.toContain("Alice");
      expect(inactivePlatform.stdout).not.toContain("Grace");

      // Pipe: count total employees (minus header)
      const totalCount = await run("tail -n 8 /data/employees.csv | wc -l");
      expect(totalCount.stdout.trim()).toMatch(/8/);

      // Pipe: count engineers
      const engCount = await run("cat /data/employees.csv | grep engineer | wc -l");
      expect(engCount.stdout.trim()).toMatch(/4/);

      // Pipe: count inactive members
      const inactiveCount = await run("cat /data/employees.csv | grep inactive | wc -l");
      expect(inactiveCount.stdout.trim()).toMatch(/2/);

      // Pipe: head shows first 3 data rows
      const first3 = await run("cat /data/employees.csv | head -n 4");
      expect(first3.stdout).toContain("name,role,team,status");
      expect(first3.stdout).toContain("Alice");
      expect(first3.stdout).toContain("Bob");
      expect(first3.stdout).toContain("Charlie");
      expect(first3.stdout).not.toContain("Diana");

      // Write filtered results to a new file via redirect
      await run("cat /data/employees.csv | grep engineer > /data/engineers.csv");
      const engFile = await run("cat /data/engineers.csv");
      expect(engFile.stdout).toContain("Alice");
      expect(engFile.stdout).toContain("Eve");
      expect(engFile.stdout).not.toContain("Bob");

      // Grep with line numbers
      const lineNums = await run("grep -n active /data/employees.csv");
      expect(lineNums.stdout).toContain("2:"); // Alice is line 2
      expect(lineNums.stdout).toContain("active");
    });
  });

  // ---------------------------------------------------------------------------
  // Task 8: Working with cd and relative paths
  // ---------------------------------------------------------------------------
  describe("Task 8: Working with cd and relative paths", () => {
    it("navigates directories and uses relative paths", async () => {
      // Set up a directory structure
      await run("mkdir -p /workspace/project-a/src");
      await run("mkdir -p /workspace/project-b/src");
      await run('echo "Project A code" > /workspace/project-a/src/main.ts');
      await run('echo "Project B code" > /workspace/project-b/src/main.ts');
      await run('echo "Shared config" > /workspace/shared.conf');

      // Start at root
      const pwd1 = await run("pwd");
      expect(pwd1.stdout.trim()).toBe("/");

      // Navigate to workspace
      await run("cd /workspace");
      const pwd2 = await run("pwd");
      expect(pwd2.stdout.trim()).toBe("/workspace");

      // List current directory (no path argument)
      const ls = await run("ls");
      expect(ls.stdout).toContain("project-a");
      expect(ls.stdout).toContain("project-b");
      expect(ls.stdout).toContain("shared.conf");

      // Navigate deeper using relative path
      await run("cd project-a");
      const pwd3 = await run("pwd");
      expect(pwd3.stdout.trim()).toBe("/workspace/project-a");

      // Read a file using relative path
      const content = await run("cat src/main.ts");
      expect(content.stdout).toContain("Project A code");

      // List using relative path
      const srcLs = await run("ls src");
      expect(srcLs.stdout).toContain("main.ts");

      // Navigate back up
      await run("cd /workspace/project-b");
      const pwd4 = await run("pwd");
      expect(pwd4.stdout.trim()).toBe("/workspace/project-b");

      // Read project B's file
      const contentB = await run("cat src/main.ts");
      expect(contentB.stdout).toContain("Project B code");

      // Find from relative path
      await run("cd /workspace");
      const found = await run("find . -name *.ts");
      expect(found.stdout).toContain("main.ts");

      // Go back to root
      await run("cd /");
      const pwd5 = await run("pwd");
      expect(pwd5.stdout.trim()).toBe("/");
    });
  });
});
