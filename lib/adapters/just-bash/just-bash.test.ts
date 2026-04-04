import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Bash } from "just-bash";
import { ensureSetup } from "../../../tests/global-setup.js";
import { TEST_ADAPTERS } from "../../../tests/helpers.js";
import type { SqlClient } from "../../../tests/helpers.js";
import { PgFileSystem } from "../../core/filesystem.js";
import { PostgresFileSystem } from "./adapter.js";

describe.each(TEST_ADAPTERS)("just-bash integration [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let pgFs: PgFileSystem;
  let bash: Bash;
  const wsId = "just-bash-test";

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
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [wsId]);
    pgFs = new PgFileSystem({ db: client, workspaceId: wsId });
    await pgFs.init();
    bash = new Bash({ fs: new PostgresFileSystem(pgFs) });
  });

  it("echo", async () => {
    const result = await bash.exec("echo hello world");
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("mkdir + ls", async () => {
    await bash.exec("mkdir -p /workspace/sub");
    const result = await bash.exec("ls /workspace");
    expect(result.stdout.trim()).toBe("sub");
  });

  it("write and read a file", async () => {
    await bash.exec("echo 'file content' > /tmp/test.txt");
    const result = await bash.exec("cat /tmp/test.txt");
    expect(result.stdout).toBe("file content\n");
  });

  it("pipes", async () => {
    await bash.exec("echo -e 'banana\\napple\\ncherry' > /tmp/fruits.txt");
    const result = await bash.exec("cat /tmp/fruits.txt | sort");
    expect(result.stdout).toBe("apple\nbanana\ncherry\n");
  });

  it("cp and mv", async () => {
    await bash.exec("echo data > /tmp/a.txt");
    await bash.exec("cp /tmp/a.txt /tmp/b.txt");
    await bash.exec("mv /tmp/b.txt /tmp/c.txt");

    const a = await bash.exec("cat /tmp/a.txt");
    expect(a.stdout).toBe("data\n");

    const c = await bash.exec("cat /tmp/c.txt");
    expect(c.stdout).toBe("data\n");

    const b = await bash.exec("cat /tmp/b.txt");
    expect(b.exitCode).not.toBe(0);
  });

  it("rm", async () => {
    await bash.exec("echo x > /tmp/del.txt");
    await bash.exec("rm /tmp/del.txt");
    const result = await bash.exec("cat /tmp/del.txt");
    expect(result.exitCode).not.toBe(0);
  });

  it("stat", async () => {
    await bash.exec("echo hello > /tmp/s.txt");
    const result = await bash.exec("stat /tmp/s.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("s.txt");
  });

  it("symlink + readlink", async () => {
    await bash.exec("echo target > /tmp/real.txt");
    await bash.exec("ln -s /tmp/real.txt /tmp/link.txt");
    const cat = await bash.exec("cat /tmp/link.txt");
    expect(cat.stdout).toBe("target\n");
    const rl = await bash.exec("readlink /tmp/link.txt");
    expect(rl.stdout.trim()).toBe("/tmp/real.txt");
  });

  it("grep", async () => {
    await bash.exec("echo -e 'foo\\nbar\\nbaz' > /tmp/g.txt");
    const result = await bash.exec("grep ba /tmp/g.txt");
    expect(result.stdout).toBe("bar\nbaz\n");
  });

  it("wc", async () => {
    await bash.exec("echo -e 'one\\ntwo\\nthree' > /tmp/wc.txt");
    const result = await bash.exec("wc -l /tmp/wc.txt");
    expect(result.stdout.trim()).toContain("3");
  });

  it("head and tail", async () => {
    await bash.exec("echo -e 'a\\nb\\nc\\nd\\ne' > /tmp/ht.txt");
    const head = await bash.exec("head -n 2 /tmp/ht.txt");
    expect(head.stdout).toBe("a\nb\n");
    const tail = await bash.exec("tail -n 2 /tmp/ht.txt");
    expect(tail.stdout).toBe("d\ne\n");
  });

  it("append with >>", async () => {
    await bash.exec("echo first > /tmp/app.txt");
    await bash.exec("echo second >> /tmp/app.txt");
    const result = await bash.exec("cat /tmp/app.txt");
    expect(result.stdout).toBe("first\nsecond\n");
  });

  it("chmod", async () => {
    await bash.exec("echo x > /tmp/ch.txt");
    await bash.exec("chmod 755 /tmp/ch.txt");
    const result = await bash.exec("stat /tmp/ch.txt");
    expect(result.stdout).toContain("755");
  });
});
