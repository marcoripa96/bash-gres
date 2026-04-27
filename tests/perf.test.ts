import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const PERF_MV_WORKSPACE = "perf-mv";
const PERF_SYMLINK_WORKSPACE = "perf-symlink";

interface RecordingClient {
  client: SqlClient;
  queries: string[];
}

/**
 * Wraps a SqlClient to record every SQL statement executed (including those
 * inside transactions / nested transactions). Used to assert that hot-path
 * operations do not pull columns they don't need.
 */
function recording(inner: SqlClient): RecordingClient {
  const queries: string[] = [];
  function wrap(c: SqlClient): SqlClient {
    return {
      query: (text, params) => {
        queries.push(text);
        return c.query(text, params);
      },
      transaction: (fn) => c.transaction((tx) => fn(wrap(tx))),
    };
  }
  return { client: wrap(inner), queries };
}

describe.each(TEST_ADAPTERS)("perf: no-content-fetch on mv [%s]", (_name, factory) => {
  let inner: SqlClient;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    inner = test.client;
    teardown = test.teardown;
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(inner, PERF_MV_WORKSPACE);
  });

  it("mv does not SELECT content or binary_data", async () => {
    // Seed a file using the inner client so seeding is not part of the recording.
    const seedFs = new PgFileSystem({ db: inner, workspaceId: PERF_MV_WORKSPACE });
    await seedFs.init();
    await seedFs.writeFile("/big.bin", new Uint8Array(64 * 1024));

    // Now build a recording client and run mv through it.
    const rec = recording(inner);
    const fs = new PgFileSystem({ db: rec.client, workspaceId: PERF_MV_WORKSPACE });

    rec.queries.length = 0;
    await fs.mv("/big.bin", "/moved.bin");

    // Every SELECT that ran during mv must avoid the heavy columns.
    const selects = rec.queries.filter((q) => /^\s*(SELECT|WITH)\b/i.test(q));
    expect(selects.length).toBeGreaterThan(0);
    for (const q of selects) {
      expect(q).not.toMatch(/\bcontent\b/);
      expect(q).not.toMatch(/\bbinary_data\b/);
      expect(q).not.toMatch(/\bembedding\b/);
      expect(q).not.toMatch(/SELECT\s+\*/i);
    }
    expect(await fs.readFile("/moved.bin")).toBeDefined();
  });

  it("mv of a directory still locks descendants without pulling content", async () => {
    const seedFs = new PgFileSystem({ db: inner, workspaceId: PERF_MV_WORKSPACE });
    await seedFs.init();
    await seedFs.writeFile("/src/a.txt", "a");
    await seedFs.writeFile("/src/nested/b.txt", "b");

    const rec = recording(inner);
    const fs = new PgFileSystem({ db: rec.client, workspaceId: PERF_MV_WORKSPACE });

    rec.queries.length = 0;
    await fs.mv("/src", "/dst");

    const selects = rec.queries.filter((q) => /^\s*(SELECT|WITH)\b/i.test(q));
    for (const q of selects) {
      expect(q).not.toMatch(/\bcontent\b/);
      expect(q).not.toMatch(/\bbinary_data\b/);
      expect(q).not.toMatch(/\bembedding\b/);
      expect(q).not.toMatch(/SELECT\s+\*/i);
    }
    expect(await fs.readFile("/dst/a.txt")).toBe("a");
    expect(await fs.readFile("/dst/nested/b.txt")).toBe("b");
  });
});

describe.each(TEST_ADAPTERS)("perf: symlink chain reads metadata [%s]", (_name, factory) => {
  let inner: SqlClient;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    inner = test.client;
    teardown = test.teardown;
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(inner, PERF_SYMLINK_WORKSPACE);
  });

  it("readFile through a 3-link chain pulls content only once", async () => {
    const seedFs = new PgFileSystem({
      db: inner,
      workspaceId: PERF_SYMLINK_WORKSPACE,
    });
    await seedFs.init();
    await seedFs.writeFile("/target.txt", "payload");
    await seedFs.symlink("/target.txt", "/link1");
    await seedFs.symlink("/link1", "/link2");
    await seedFs.symlink("/link2", "/link3");

    const rec = recording(inner);
    const fs = new PgFileSystem({
      db: rec.client,
      workspaceId: PERF_SYMLINK_WORKSPACE,
    });

    rec.queries.length = 0;
    expect(await fs.readFile("/link3")).toBe("payload");

    // Symlink resolution walks fs_entries metadata only; file bytes are pulled
    // once from fs_blobs after the chain terminus is known.
    const entryReads = rec.queries.filter((q) => /\bFROM\s+fs_entries\b/i.test(q));
    expect(entryReads.length).toBeGreaterThan(0);
    for (const q of entryReads) {
      expect(q).not.toMatch(/\bcontent\b/);
      expect(q).not.toMatch(/\bbinary_data\b/);
      expect(q).not.toMatch(/\bembedding\b/);
      expect(q).not.toMatch(/SELECT\s+\*/i);
    }

    const blobReads = rec.queries.filter((q) => /\bFROM\s+fs_blobs\b/i.test(q));
    expect(blobReads.length).toBe(1);
    expect(blobReads[0]).toMatch(/\bcontent\b/);
    expect(blobReads[0]).toMatch(/\bbinary_data\b/);
  });

  it("readFile of a non-symlink resolves metadata once and content once", async () => {
    const seedFs = new PgFileSystem({
      db: inner,
      workspaceId: PERF_SYMLINK_WORKSPACE,
    });
    await seedFs.init();
    await seedFs.writeFile("/regular.txt", "data");

    const rec = recording(inner);
    const fs = new PgFileSystem({
      db: rec.client,
      workspaceId: PERF_SYMLINK_WORKSPACE,
    });

    rec.queries.length = 0;
    expect(await fs.readFile("/regular.txt")).toBe("data");

    const entryReads = rec.queries.filter((q) => /\bFROM\s+fs_entries\b/i.test(q));
    const blobReads = rec.queries.filter((q) => /\bFROM\s+fs_blobs\b/i.test(q));
    expect(entryReads.length).toBe(1);
    expect(blobReads.length).toBe(1);
    expect(entryReads[0]).not.toMatch(/\bcontent\b/);
    expect(entryReads[0]).not.toMatch(/\bbinary_data\b/);
    expect(entryReads[0]).not.toMatch(/\bembedding\b/);
  });
});
