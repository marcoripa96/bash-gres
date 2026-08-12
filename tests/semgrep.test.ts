import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Bash } from "just-bash";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { setup } from "../lib/core/setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { createSemgrepCommand } from "../lib/adapters/just-bash/index.js";
import { SqlError } from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

const WS = "semgrep-workspace";

const ABOUT = [
  "---",
  'title: "Widget Co"',
  "---",
  "",
  "We build widgets.",
  "",
  "## Shipping",
  "",
  "Shipping is free over fifty euros. Shipping takes two days.",
  "",
  "## Team",
  "",
  "Two hundred people build widgets here.",
].join("\n");

const PRICING = [
  "# Pricing",
  "",
  "The starter plan costs nine euros per month.",
].join("\n");

/** Same deterministic vocabulary space the vector-search tests use. */
function vocabEmbed(text: string): number[] {
  const t = text.toLowerCase();
  return [
    /ship|deliver/.test(t) ? 1 : 0.05,
    /price|cost|euro/.test(t) ? 1 : 0.05,
    /widget/.test(t) ? 1 : 0.05,
  ];
}

/** Simulate an old database migrated before fs_blob_chunks existed. */
function missingChunkTableClient(real: SqlClient): SqlClient {
  return {
    query(text, params) {
      if (text.includes("fs_blob_chunks")) {
        throw new SqlError('relation "fs_blob_chunks" does not exist', "42P01");
      }
      return real.query(text, params);
    },
    transaction(fn) {
      return real.transaction((tx) => fn(missingChunkTableClient(tx)));
    },
  };
}

/** One output line: path:start-end  [rank]  preview */
const HIT_LINE = /^(\/[^:]+):(\d+)-(\d+) {2}\[\d+\.\d{4}\] {2}(.*)$/;

describe.each(TEST_ADAPTERS)("semgrep command [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;

  const makeBash = (fs: PgFileSystem) =>
    new Bash({ fs, customCommands: [createSemgrepCommand({ fs })] });

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
    await setup(client, {
      enableRLS: false,
      enableFullTextSearch: true,
      enableVectorSearch: true,
      embeddingDimensions: 3,
    });
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(client, WS);
    await client.query(
      "DELETE FROM fs_chunk_embeddings WHERE workspace_id = $1",
      [WS],
    );
  });

  async function seed(fs: PgFileSystem) {
    await fs.init();
    await fs.writeFile("/content/about.md", ABOUT);
    await fs.writeFile("/content/pricing.md", PRICING);
    await fs.writeFile("/docs/notes.md", "# Notes\n\nShipping labels live here.");
  }

  it("BM25-only without an embedder: grep-style, addressable output", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await seed(fs);
    const bash = makeBash(fs);

    const result = await bash.exec('semgrep "shipping"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).toMatch(HIT_LINE);

    // The dedicated section wins, breadcrumb + first body line as preview —
    // and the line range hydrates with the session's own tooling.
    const [path, start, end] = lines[0]!.match(HIT_LINE)!.slice(1);
    expect(lines[0]).toContain("Widget Co > Shipping — Shipping is free");
    const sed = await bash.exec(`sed -n ${start},${end}p ${path}`);
    expect(sed.stdout).toContain("Shipping is free over fifty euros.");
  });

  it("hybrid with an embedder: a synonym-only query still surfaces the section", async () => {
    const fs = new PgFileSystem({
      db: client,
      workspaceId: WS,
      chunking: true,
      embed: async (texts) => texts.map(vocabEmbed),
      embeddingDimensions: 3,
    });
    await seed(fs);
    await fs.indexChunkEmbeddings();

    // No token overlap: BM25-only exits 1 empty-handed…
    const textOnly = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await textOnly.init();
    const noVector = await makeBash(textOnly).exec('semgrep "delivery"');
    expect(noVector.exitCode).toBe(1);
    expect(noVector.stdout).toBe("");

    // …the embedder-equipped handle dispatches hybrid and finds it.
    const hybrid = await makeBash(fs).exec('semgrep "delivery"');
    expect(hybrid.exitCode).toBe(0);
    const shipping = hybrid.stdout
      .trimEnd()
      .split("\n")
      .find((l) => l.startsWith("/content/about.md"));
    expect(shipping).toContain("Widget Co > Shipping");
  });

  it("-k caps the hits, in both '-k N' and '-kN' forms", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await seed(fs);
    const bash = makeBash(fs);

    const spaced = await bash.exec('semgrep -k 1 "shipping"');
    expect(spaced.exitCode).toBe(0);
    expect(spaced.stdout.trimEnd().split("\n")).toHaveLength(1);

    const glued = await bash.exec('semgrep -k1 "shipping"');
    expect(glued.stdout).toBe(spaced.stdout);
  });

  it("path argument scopes the search, resolved against the session cwd", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await seed(fs);
    const bash = makeBash(fs);

    const absolute = await bash.exec('semgrep "shipping" /docs');
    expect(absolute.exitCode).toBe(0);
    const paths = absolute.stdout
      .trimEnd()
      .split("\n")
      .map((l) => l.match(HIT_LINE)![1]);
    expect(paths).toEqual(["/docs/notes.md"]);

    const relative = await bash.exec('cd /docs && semgrep "shipping" .');
    expect(relative.stdout).toBe(absolute.stdout);
  });

  it("no hits: exit 1 and silent, like grep", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await seed(fs);

    const result = await makeBash(fs).exec('semgrep "zeppelin"');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("usage errors: exit 2 with the usage line on stderr", async () => {
    const fs = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await seed(fs);
    const bash = makeBash(fs);

    for (const cmd of [
      "semgrep",
      'semgrep -k "shipping"',
      'semgrep -k 0 "shipping"',
      'semgrep --fuzzy "shipping"',
      'semgrep "shipping" /docs extra',
    ]) {
      const result = await bash.exec(cmd);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: semgrep");
      expect(result.stdout).toBe("");
    }

    // `--` ends flag parsing: a leading-dash query is a query, not an option.
    const dashed = await bash.exec("semgrep -- -k");
    expect(dashed.exitCode).toBe(1);
    expect(dashed.stderr).toBe("");
  });

  it("missing chunk table: exit 2 with the migration story", async () => {
    const seeded = new PgFileSystem({ db: client, workspaceId: WS, chunking: true });
    await seed(seeded); // real init + content via the real client
    const fs = new PgFileSystem({
      db: missingChunkTableClient(client),
      workspaceId: WS,
    });

    const result = await makeBash(fs).exec('semgrep "shipping"');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("fs_blob_chunks");
  });
});
