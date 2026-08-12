import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type { SqlClient } from "./helpers.js";

const WS = "chunks-workspace";

const PAGE = [
  "---",
  'title: "Widget Co"',
  'summary: "Widgets since 1999."',
  "---",
  "",
  "We build widgets.",
  "",
  "## Shipping",
  "",
  "Free over 50.",
  "",
  "## Team",
  "",
  "Two hundred people.",
].join("\n");

async function chunkRowCount(
  client: SqlClient,
  workspaceId: string,
): Promise<number> {
  const r = await client.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM fs_blob_chunks WHERE workspace_id = $1",
    [workspaceId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

describe.each(TEST_ADAPTERS)("fs_blob_chunks [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;

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
    await resetWorkspace(client, WS);
    fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await fs.init();
  });

  it("stores section chunks on write and reads them back in order", async () => {
    await fs.writeFile("/content/about.md", PAGE);
    const chunks = await fs.readFileChunks("/content/about.md");

    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(chunks[0]!.headingPath).toBeNull(); // front matter
    expect(chunks[0]!.content).toContain("summary:");
    expect(chunks[1]!.headingPath).toBe("Widget Co");
    expect(chunks[2]!.headingPath).toBe("Widget Co > Shipping");
    expect(chunks[3]!.headingPath).toBe("Widget Co > Team");
  });

  it("hydrates a chunk's line range back to its exact body", async () => {
    await fs.writeFile("/content/about.md", PAGE);
    for (const chunk of await fs.readFileChunks("/content/about.md")) {
      const { content } = await fs.readFileLines("/content/about.md", {
        offset: chunk.startLine,
        limit: chunk.endLine - chunk.startLine + 1,
      });
      expect(chunk.content.endsWith(content)).toBe(true);
    }
  });

  it("chunks once per blob: rewrites and copies add no rows", async () => {
    await fs.writeFile("/a.md", PAGE);
    const after = await chunkRowCount(client, WS);
    expect(after).toBeGreaterThan(0);

    await fs.writeFile("/a.md", PAGE); // unchanged rewrite
    await fs.writeFile("/b.md", PAGE); // same content, other path
    await fs.cp("/a.md", "/c.md"); // blob-sharing copy
    expect(await chunkRowCount(client, WS)).toBe(after);

    // ...but all three paths resolve to the shared chunk set.
    expect(await fs.readFileChunks("/b.md")).toEqual(
      await fs.readFileChunks("/a.md"),
    );
    expect(await fs.readFileChunks("/c.md")).toEqual(
      await fs.readFileChunks("/a.md"),
    );
  });

  it("chunks changed content as a new blob's rows", async () => {
    await fs.writeFile("/a.md", PAGE);
    const before = await chunkRowCount(client, WS);
    await fs.writeFile("/a.md", PAGE + "\n\n## New\n\nSection.");
    expect(await chunkRowCount(client, WS)).toBeGreaterThan(before);
    const chunks = await fs.readFileChunks("/a.md");
    expect(chunks.at(-1)!.headingPath).toBe("Widget Co > New");
  });

  it("skips binary and empty files", async () => {
    await fs.writeFile("/bin.dat", new Uint8Array([1, 2, 3]));
    await fs.writeFile("/empty.md", "");
    expect(await chunkRowCount(client, WS)).toBe(0);
    expect(await fs.readFileChunks("/bin.dat")).toEqual([]);
    expect(await fs.readFileChunks("/empty.md")).toEqual([]);
  });

  it("appendFile re-chunks the merged content", async () => {
    await fs.writeFile("/a.md", "# T\n\nstart");
    await fs.appendFile("/a.md", "\n\n## More\n\nappended");
    const chunks = await fs.readFileChunks("/a.md");
    expect(chunks.at(-1)!.headingPath).toBe("T > More");
  });

  it("follows symlinks and rejects directories / missing paths", async () => {
    await fs.writeFile("/content/about.md", PAGE);
    await fs.symlink("/content/about.md", "/link.md");
    expect(await fs.readFileChunks("/link.md")).toEqual(
      await fs.readFileChunks("/content/about.md"),
    );
    await expect(fs.readFileChunks("/content")).rejects.toThrow(/EISDIR|directory/);
    await expect(fs.readFileChunks("/nope.md")).rejects.toThrow(/ENOENT|no such/);
  });

  it("shares chunks across versions (fork sees the same blob's rows)", async () => {
    await fs.writeFile("/a.md", PAGE);
    const rows = await chunkRowCount(client, WS);
    const forked = await fs.fork("crawl");
    expect(await forked.readFileChunks("/a.md")).toEqual(
      await fs.readFileChunks("/a.md"),
    );
    expect(await chunkRowCount(client, WS)).toBe(rows); // nothing re-chunked
  });

  it("isolates workspaces", async () => {
    const OTHER = "chunks-workspace-other";
    await resetWorkspace(client, OTHER);
    const other = new PgFileSystem({
      db: client,
      workspaceId: OTHER,
      chunking: true,
    });
    await other.init();

    await fs.writeFile("/a.md", PAGE);
    expect(await chunkRowCount(client, OTHER)).toBe(0);

    await other.writeFile("/a.md", PAGE);
    expect(await chunkRowCount(client, OTHER)).toBeGreaterThan(0);
    await resetWorkspace(client, OTHER);
  });

  it("drops chunk rows with their blob (FK cascade)", async () => {
    await fs.writeFile("/a.md", PAGE);
    expect(await chunkRowCount(client, WS)).toBeGreaterThan(0);
    await client.query("DELETE FROM fs_blobs WHERE workspace_id = $1", [WS]);
    expect(await chunkRowCount(client, WS)).toBe(0);
  });

  describe("backfillChunks", () => {
    it("chunks pre-existing content, once", async () => {
      const plain = new PgFileSystem({ db: client, workspaceId: WS });
      await plain.init();
      await plain.writeFile("/old.md", PAGE);
      await plain.writeFile("/old2.md", "# Two\n\nmore");
      await plain.writeFile("/bin.dat", new Uint8Array([9]));
      expect(await chunkRowCount(client, WS)).toBe(0);

      const chunked = new PgFileSystem({
        db: client,
        workspaceId: WS,
        chunking: true,
      });
      const first = await chunked.backfillChunks();
      expect(first.blobs).toBe(2);
      expect(first.chunks).toBeGreaterThan(0);
      expect(await chunkRowCount(client, WS)).toBe(first.chunks);

      const again = await chunked.backfillChunks();
      expect(again).toEqual({ blobs: 0, chunks: 0 });

      // Backfilled rows match what the write path would have produced.
      const chunks = await chunked.readFileChunks("/old.md");
      expect(chunks[2]!.headingPath).toBe("Widget Co > Shipping");
    });

    it("backfills only blobs visible at the handle's version", async () => {
      const plain = new PgFileSystem({ db: client, workspaceId: WS });
      await plain.init();
      await plain.writeFile("/a.md", PAGE);
      await plain.writeFile("/b.md", "# B\n\nold body");
      const branch = await plain.fork("crawl");
      await branch.writeFile("/b.md", "# B\n\nnew body");

      // On the branch: /a.md's blob plus the branch's /b.md — never the
      // shadowed main-only blob.
      const crawlChunked = new PgFileSystem({
        db: client,
        workspaceId: WS,
        chunking: true,
        version: "crawl",
      });
      expect((await crawlChunked.backfillChunks()).blobs).toBe(2);

      // The main handle picks up exactly the blob the branch pass skipped
      // (/a.md's shared blob is already chunked — content-addressed).
      const mainChunked = new PgFileSystem({
        db: client,
        workspaceId: WS,
        chunking: true,
      });
      expect((await mainChunked.backfillChunks()).blobs).toBe(1);
    });

    it("skips excluded paths", async () => {
      const plain = new PgFileSystem({ db: client, workspaceId: WS });
      await plain.init();
      await plain.writeFile("/keep.md", "# K\n\nkeep this");
      await plain.writeFile("/secret.md", "# S\n\nsecret notes");

      const excluded = new PgFileSystem({
        db: client,
        workspaceId: WS,
        chunking: true,
        exclude: ["secret.md"],
      });
      expect((await excluded.backfillChunks()).blobs).toBe(1);
      const chunks = await excluded.readFileChunks("/keep.md");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("requires the chunking option and write permission", async () => {
      const plain = new PgFileSystem({ db: client, workspaceId: WS });
      await expect(plain.backfillChunks()).rejects.toThrow(/chunking/);

      const readonly = new PgFileSystem({
        db: client,
        workspaceId: WS,
        chunking: true,
        permissions: { read: true, write: false },
      });
      await expect(readonly.backfillChunks()).rejects.toThrow(
        /EPERM|read-only/,
      );
    });
  });
});
