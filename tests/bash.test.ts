import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestClient, resetDb } from "./helpers.js";
import { PgFileSystem } from "../src/core/filesystem.js";
import { BashInterpreter } from "../src/core/bash.js";
import { setup } from "../src/core/setup.js";
import type { SqlClient } from "./helpers.js";
import type postgres from "postgres";

describe("BashInterpreter", () => {
  let sql: postgres.Sql;
  let db: SqlClient;
  let fs: PgFileSystem;
  let bash: BashInterpreter;

  beforeAll(async () => {
    const test = createTestClient();
    sql = test.sql;
    db = test.client;
    await setup(db, {
      enableRLS: false,
      enableFullTextSearch: false,
      enableVectorSearch: false,
    });
  });

  afterAll(async () => {
    await resetDb(db);
    await sql.end();
  });

  beforeEach(async () => {
    await db.query(
      "DELETE FROM fs_nodes WHERE session_id = $1",
      ["bash-test"],
    );
    fs = new PgFileSystem({ db, sessionId: "bash-test" });
    await fs.init();
    bash = new BashInterpreter(fs);
  });

  describe("echo + redirect", () => {
    it("writes to file via >", async () => {
      const result = await bash.execute('echo "hello world" > /greeting.txt');
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile("/greeting.txt")).toBe("hello world\n");
    });

    it("appends to file via >>", async () => {
      await bash.execute('echo "line1" > /log.txt');
      await bash.execute('echo "line2" >> /log.txt');
      expect(await fs.readFile("/log.txt")).toBe("line1\nline2\n");
    });
  });

  describe("cat", () => {
    it("reads file content", async () => {
      await fs.writeFile("/test.txt", "content here");
      const result = await bash.execute("cat /test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("content here");
    });
  });

  describe("ls", () => {
    it("lists directory contents", async () => {
      await fs.mkdir("/mydir");
      await fs.writeFile("/mydir/a.txt", "a");
      await fs.writeFile("/mydir/b.txt", "b");
      const result = await bash.execute("ls /mydir");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split("\n").sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("lists with -la flag", async () => {
      await fs.writeFile("/test.txt", "hello");
      const result = await bash.execute("ls -la /");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test.txt");
    });
  });

  describe("mkdir", () => {
    it("creates directory", async () => {
      const result = await bash.execute("mkdir /newdir");
      expect(result.exitCode).toBe(0);
      expect(await fs.exists("/newdir")).toBe(true);
    });

    it("creates nested with -p", async () => {
      const result = await bash.execute("mkdir -p /a/b/c");
      expect(result.exitCode).toBe(0);
      expect(await fs.exists("/a/b/c")).toBe(true);
    });
  });

  describe("rm", () => {
    it("removes a file", async () => {
      await fs.writeFile("/doomed.txt", "bye");
      const result = await bash.execute("rm /doomed.txt");
      expect(result.exitCode).toBe(0);
      expect(await fs.exists("/doomed.txt")).toBe(false);
    });

    it("removes recursively with -rf", async () => {
      await fs.mkdir("/tree/sub", { recursive: true });
      await fs.writeFile("/tree/sub/file.txt", "data");
      const result = await bash.execute("rm -rf /tree");
      expect(result.exitCode).toBe(0);
      expect(await fs.exists("/tree")).toBe(false);
    });
  });

  describe("cp and mv", () => {
    it("copies a file", async () => {
      await fs.writeFile("/src.txt", "data");
      const result = await bash.execute("cp /src.txt /dst.txt");
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile("/dst.txt")).toBe("data");
    });

    it("moves a file", async () => {
      await fs.writeFile("/old.txt", "data");
      const result = await bash.execute("mv /old.txt /new.txt");
      expect(result.exitCode).toBe(0);
      expect(await fs.exists("/old.txt")).toBe(false);
      expect(await fs.readFile("/new.txt")).toBe("data");
    });
  });

  describe("pwd and cd", () => {
    it("starts at root", async () => {
      const result = await bash.execute("pwd");
      expect(result.stdout.trim()).toBe("/");
    });

    it("changes directory", async () => {
      await fs.mkdir("/mydir");
      await bash.execute("cd /mydir");
      const result = await bash.execute("pwd");
      expect(result.stdout.trim()).toBe("/mydir");
    });
  });

  describe("touch", () => {
    it("creates empty file", async () => {
      await bash.execute("touch /new.txt");
      expect(await fs.exists("/new.txt")).toBe(true);
      expect(await fs.readFile("/new.txt")).toBe("");
    });
  });

  describe("head and tail", () => {
    it("shows first n lines", async () => {
      await fs.writeFile("/lines.txt", "1\n2\n3\n4\n5\n");
      const result = await bash.execute("head -n 3 /lines.txt");
      expect(result.stdout.trim().split("\n")).toEqual(["1", "2", "3"]);
    });

    it("shows last n lines", async () => {
      await fs.writeFile("/lines.txt", "1\n2\n3\n4\n5\n");
      const result = await bash.execute("tail -n 2 /lines.txt");
      expect(result.stdout).toContain("4");
      expect(result.stdout).toContain("5");
    });
  });

  describe("wc", () => {
    it("counts lines, words, chars", async () => {
      await fs.writeFile("/text.txt", "hello world\nfoo bar\n");
      const result = await bash.execute("wc /text.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("2");
      expect(result.stdout).toContain("4");
    });
  });

  describe("tree", () => {
    it("shows directory tree", async () => {
      await fs.mkdir("/project/src", { recursive: true });
      await fs.writeFile("/project/src/index.ts", "code");
      await fs.writeFile("/project/package.json", "{}");
      const result = await bash.execute("tree /project");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("src/");
      expect(result.stdout).toContain("index.ts");
      expect(result.stdout).toContain("package.json");
    });
  });

  describe("find", () => {
    it("finds files by name pattern", async () => {
      await fs.mkdir("/project/src", { recursive: true });
      await fs.writeFile("/project/src/app.ts", "code");
      await fs.writeFile("/project/src/util.ts", "code");
      await fs.writeFile("/project/readme.md", "doc");
      const result = await bash.execute("find /project -name *.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app.ts");
      expect(result.stdout).toContain("util.ts");
      expect(result.stdout).not.toContain("readme.md");
    });
  });

  describe("grep", () => {
    it("searches file content", async () => {
      await fs.writeFile("/code.ts", "const foo = 1;\nconst bar = 2;\nconst foo_bar = 3;");
      const result = await bash.execute("grep foo /code.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("const foo = 1;");
      expect(result.stdout).toContain("const foo_bar = 3;");
      expect(result.stdout).not.toContain("const bar = 2;");
    });
  });

  describe("pipe", () => {
    it("pipes output between commands", async () => {
      await fs.writeFile("/data.txt", "alpha\nbeta\ngamma\ndelta\n");
      const result = await bash.execute("cat /data.txt | head -n 2");
      expect(result.stdout.trim().split("\n")).toEqual(["alpha", "beta"]);
    });
  });

  describe("unknown command", () => {
    it("returns error for unknown commands", async () => {
      const result = await bash.execute("nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("command not found");
    });
  });
});
