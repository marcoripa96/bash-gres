import { describe, it, expect } from "vitest";
import {
  chunkMarkdown,
  type MarkdownChunk,
} from "../lib/core/chunking.js";

/** Re-slice the source by a chunk's line range — must equal its body. */
function hydrate(text: string, chunk: MarkdownChunk): string {
  return text
    .split("\n")
    .slice(chunk.startLine - 1, chunk.endLine)
    .join("\n");
}

function expectExactSlices(text: string, chunks: MarkdownChunk[]): void {
  for (const chunk of chunks) {
    expect(hydrate(text, chunk)).toBe(chunk.body);
  }
}

function expectOrderedNonOverlapping(chunks: MarkdownChunk[]): void {
  chunks.forEach((chunk, i) => {
    expect(chunk.index).toBe(i);
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    if (i > 0) {
      expect(chunk.startLine).toBeGreaterThan(chunks[i - 1]!.endLine);
    }
  });
}

describe("chunkMarkdown", () => {
  it("yields nothing for empty or blank input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  \n")).toEqual([]);
  });

  it("keeps a small headingless document as one whole-page chunk", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n";
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      startLine: 1,
      endLine: 3,
      headingPath: null,
    });
    expect(chunks[0]!.content).toBe(chunks[0]!.body);
    expectExactSlices(text, chunks);
  });

  it("emits front matter as chunk 0 and titles the breadcrumbs from it", () => {
    const text = [
      "---",
      'title: "Widget Co — About"',
      'summary: "Builds widgets."',
      "---",
      "",
      "We build widgets.",
      "",
      "## Team",
      "",
      "Two hundred people.",
    ].join("\n");
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(3);

    const [fm, preamble, team] = chunks as [
      MarkdownChunk,
      MarkdownChunk,
      MarkdownChunk,
    ];
    expect(fm).toMatchObject({ startLine: 1, endLine: 4, headingPath: null });
    expect(fm.content).toBe(fm.body);
    expect(fm.body).toContain("summary:");

    expect(preamble.headingPath).toBe("Widget Co — About");
    expect(preamble.content).toBe(
      "Widget Co — About\n\nWe build widgets.",
    );

    expect(team.headingPath).toBe("Widget Co — About > Team");
    expect(team.startLine).toBe(8); // the heading line belongs to its section
    expect(team.body).toContain("## Team");
    expect(team.content.startsWith("Widget Co — About > Team\n\n")).toBe(true);

    expectExactSlices(text, chunks);
    expectOrderedNonOverlapping(chunks);
  });

  it("nests and pops the heading breadcrumb correctly", () => {
    const text = [
      "# Doc",
      "intro",
      "## Alpha",
      "a",
      "### Deep",
      "d",
      "## Beta",
      "b",
    ].join("\n");
    const paths = chunkMarkdown(text).map((c) => c.headingPath);
    expect(paths).toEqual([
      "Doc",
      "Doc > Alpha",
      "Doc > Alpha > Deep",
      "Doc > Beta", // Deep popped when the H2 arrived
    ]);
  });

  it("ignores heading-looking lines inside code fences", () => {
    const text = [
      "## Real",
      "",
      "```",
      "# not a heading",
      "## also not",
      "```",
      "after",
    ].join("\n");
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toBe("Real");
    expect(chunks[0]!.endLine).toBe(7);
  });

  it("splits an oversized section at paragraph boundaries, never mid-line", () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) => `Paragraph ${i} ${"x".repeat(80)}.`,
    );
    const text = `## Long\n\n${paragraphs.join("\n\n")}`;
    // Char-exact estimator with a budget that fits ~2 paragraphs + prefix.
    const chunks = chunkMarkdown(text, {
      maxTokens: 220,
      estimateTokens: (s) => s.length,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toBe("Long");
      expect(chunk.content.length).toBeLessThanOrEqual(220);
    }
    expectExactSlices(text, chunks);
    expectOrderedNonOverlapping(chunks);
    // Every paragraph must survive in exactly one chunk.
    const joined = chunks.map((c) => c.body).join("\n");
    for (const p of paragraphs) expect(joined).toContain(p);
  });

  it("degrades to line packing for a single over-budget paragraph", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i} ${"y".repeat(40)}`);
    const text = `## Table\n\n${lines.join("\n")}`;
    const chunks = chunkMarkdown(text, {
      maxTokens: 120,
      estimateTokens: (s) => s.length,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expectExactSlices(text, chunks);
    expectOrderedNonOverlapping(chunks);
    const joined = chunks.flatMap((c) => c.body.split("\n"));
    expect(joined).toEqual(expect.arrayContaining(lines));
  });

  it("gives a single line larger than the whole budget its own chunk", () => {
    const huge = "z".repeat(500);
    const text = `## H\n\nshort\n${huge}\nshort2`;
    const chunks = chunkMarkdown(text, {
      maxTokens: 100,
      estimateTokens: (s) => s.length,
    });
    expect(chunks.some((c) => c.body === huge)).toBe(true);
    expectExactSlices(text, chunks);
    expectOrderedNonOverlapping(chunks);
  });

  it("counts the breadcrumb prefix against the budget", () => {
    const longTitle = "T".repeat(30);
    const lines = Array.from({ length: 6 }, (_, i) => `line ${i} word word`);
    const text = `# ${longTitle}\n\n${lines.join("\n")}`;
    const chunks = chunkMarkdown(text, {
      maxTokens: 100,
      estimateTokens: (s) => s.length,
    });
    // The 32-char prefix leaves a 68-char body budget, so the 6-line
    // paragraph (~101 chars) must split — without prefix accounting it would
    // fit whole and content would blow past max.
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(100);
    }
    expectExactSlices(text, chunks);
  });

  it("keeps fenced code atomic when packing paragraphs", () => {
    const fence = ["```js", "const a = 1;", "", "const b = 2;", "```"].join(
      "\n",
    );
    const text = `## Code\n\nintro paragraph\n\n${fence}\n\nafter`;
    const chunks = chunkMarkdown(text, {
      maxTokens: 60,
      estimateTokens: (s) => s.length,
    });
    // The blank line inside the fence must not split it across chunks.
    const withFence = chunks.find((c) => c.body.includes("```js"));
    expect(withFence).toBeDefined();
    expect(withFence!.body).toContain("const b = 2;");
    expectExactSlices(text, chunks);
  });

  it("handles a trailing newline without inventing a phantom line", () => {
    const chunks = chunkMarkdown("# T\n\nbody\n");
    expect(chunks[0]!.endLine).toBe(3);
  });

  it("treats an unclosed front-matter fence as plain content", () => {
    const text = "---\ntitle: broken\nno close";
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toBeNull();
    expect(chunks[0]!.body).toBe(text);
  });
});
