/**
 * Markdown-aware section chunker for the chunk-level search index
 * (`fs_blob_chunks`). Pure text → chunks; no SQL, no model calls.
 *
 * Design (card #2, from the chunking research on card #1):
 *  - The chunk unit is a heading-bounded markdown section; a document with no
 *    headings that fits the budget is a single whole-page chunk.
 *  - Oversized sections split at paragraph boundaries, and a paragraph that
 *    alone exceeds the budget splits at line boundaries — never mid-line, so
 *    every chunk is an exact line slice of the source (`startLine..endLine`,
 *    1-indexed inclusive) and can be re-read from the file.
 *  - Zero overlap between chunks; adjacency is recoverable from line ranges.
 *  - Each body chunk's indexed `content` is prefixed with its breadcrumb
 *    (document title > heading path) so a chunk that is just a price table
 *    still embeds/searches with its context. The prefix counts against the
 *    token budget (metadata-aware budgeting).
 *  - YAML front matter (`---` fenced block at line 1) becomes chunk 0 as-is
 *    (minus any `volatileFrontmatterKeys` in the indexed content): a
 *    whole-document signal chunk carrying title/summary/keyword fields.
 */

export interface ChunkingOptions {
  /**
   * Token budget per chunk, breadcrumb prefix included. Default 480 — under
   * the 512-token input ceiling of the strictest multilingual embedding
   * models, with headroom for tokenizer variance across languages.
   */
  maxTokens?: number;
  /**
   * Token estimator. Default: `ceil(length / 4)` — the usual chars-per-token
   * heuristic; inject a real tokenizer for exact budgets.
   */
  estimateTokens?: (text: string) => number;
  /**
   * Top-level front-matter keys to strip from chunk 0's indexed `content`
   * (the `body` and line range stay exact). For keys that change on every
   * write without carrying meaning — crawl timestamps like `fetchedAt` —
   * this keeps chunk 0's content hash stable, so embedding caches keyed by
   * content survive re-crawls. A stripped key's indented continuation lines
   * (multi-line values, lists) are stripped with it.
   */
  volatileFrontmatterKeys?: string[];
}

export interface MarkdownChunk {
  /** Position of this chunk in the document, 0-based and gapless. */
  index: number;
  /** First source line of the chunk, 1-indexed, inclusive. */
  startLine: number;
  /** Last source line of the chunk, 1-indexed, inclusive. */
  endLine: number;
  /** Breadcrumb of the enclosing headings ("Title > H2 > H3"), null when
   *  the document gives no title/heading context (or for front matter). */
  headingPath: string | null;
  /** Exact slice of the source: lines `startLine..endLine` joined by `\n`. */
  body: string;
  /** What gets indexed/embedded: the breadcrumb prefix + the body (for the
   *  front-matter chunk: the body minus any `volatileFrontmatterKeys`). */
  content: string;
}

const DEFAULT_MAX_TOKENS = 480;

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(```|~~~)/;

/** One contiguous run of source lines (0-based, inclusive). */
interface Span {
  start: number;
  end: number;
}

interface Section {
  /** Heading breadcrumb parts in force for this section (title included). */
  crumbs: string[];
  span: Span;
}

/** Strip one level of matching quotes from a front-matter scalar. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Rebuild the front-matter block (lines `0..close`, fences included) without
 * the listed top-level keys. A stripped key's indented continuation lines go
 * with it; any other top-level line (a new key, a comment) ends the strip.
 */
function stripFrontmatterKeys(
  lines: string[],
  close: number,
  keys: string[],
): string {
  const kept: string[] = [];
  let skipping = false;
  for (let i = 0; i <= close; i++) {
    const line = lines[i]!;
    if (i === 0 || i === close) {
      kept.push(line); // the --- fences
      continue;
    }
    const key = /^([^\s:][^:]*)\s*:/.exec(line);
    if (key) {
      skipping = keys.includes(key[1]!.trim());
    } else if (!/^[ \t]/.test(line)) {
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/** Trim blank edge lines off a span; null when nothing remains. */
function trimSpan(lines: string[], span: Span): Span | null {
  let { start, end } = span;
  while (start <= end && lines[start]!.trim() === "") start++;
  while (end >= start && lines[end]!.trim() === "") end--;
  return start > end ? null : { start, end };
}

/**
 * Split a section span into blocks: paragraph runs separated by blank lines,
 * with fenced code blocks kept atomic (a blank line inside a fence does not
 * end the block). Blocks never contain edge blank lines.
 */
function splitBlocks(lines: string[], span: Span): Span[] {
  const blocks: Span[] = [];
  let start = -1;
  let inFence = false;
  let fenceMark = "";
  for (let i = span.start; i <= span.end; i++) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line.trimStart());
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1]!;
      } else if (fence[1] === fenceMark) {
        inFence = false;
      }
    }
    if (line.trim() === "" && !inFence) {
      if (start !== -1) {
        blocks.push({ start, end: i - 1 });
        start = -1;
      }
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) blocks.push({ start, end: span.end });
  return blocks;
}

/**
 * Chunk one markdown document. Returns chunks in document order with exact,
 * non-overlapping 1-indexed line ranges. Empty/blank input yields no chunks.
 */
export function chunkMarkdown(
  text: string,
  options: ChunkingOptions = {},
): MarkdownChunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const estimate = options.estimateTokens ?? defaultEstimateTokens;
  if (text.trim() === "") return [];

  const lines = text.split("\n");
  // A trailing newline produces a final empty element that is not a source
  // line; drop it so line ranges match what readFileLines() reports.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const chunks: MarkdownChunk[] = [];
  const slice = (span: Span) =>
    lines.slice(span.start, span.end + 1).join("\n");
  const push = (span: Span, crumbs: string[]) => {
    const headingPath = crumbs.length > 0 ? crumbs.join(" > ") : null;
    const body = slice(span);
    chunks.push({
      index: chunks.length,
      startLine: span.start + 1,
      endLine: span.end + 1,
      headingPath,
      body,
      content: headingPath ? `${headingPath}\n\n${body}` : body,
    });
  };

  // -- Front matter → chunk 0, and the document title for breadcrumbs --------
  let title: string | null = null;
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        close = i;
        break;
      }
    }
    if (close !== -1) {
      for (let i = 1; i < close; i++) {
        const m = /^title\s*:\s*(.+)$/.exec(lines[i]!);
        if (m) {
          title = unquote(m[1]!);
          break;
        }
      }
      // The block is small by construction; keep it whole even if an
      // estimator would split it — front matter torn apart is useless.
      push({ start: 0, end: close }, []);
      const volatile = options.volatileFrontmatterKeys;
      if (volatile && volatile.length > 0) {
        chunks[chunks.length - 1]!.content = stripFrontmatterKeys(
          lines,
          close,
          volatile,
        );
      }
      bodyStart = close + 1;
    }
  }

  // -- Body → heading-bounded sections ----------------------------------------
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  const crumbs = () => [
    ...(title ? [title] : []),
    ...stack.map((h) => h.text),
  ];
  let current: Section | null = null;
  let inFence = false;
  let fenceMark = "";
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line.trimStart());
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1]!;
      } else if (fence[1] === fenceMark) {
        inFence = false;
      }
    }
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      if (current) sections.push(current);
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, text: heading[2]! });
      // The heading line belongs to its section, so the chunk's line range
      // stays an exact slice and the heading text rides along in the body.
      current = { crumbs: crumbs(), span: { start: i, end: i } };
    } else if (current) {
      current.span.end = i;
    } else {
      // Preamble before the first heading.
      current = { crumbs: crumbs(), span: { start: i, end: i } };
    }
  }
  if (current) sections.push(current);

  // -- Sections → chunks within the token budget ------------------------------
  for (const section of sections) {
    const span = trimSpan(lines, section.span);
    if (!span) continue;
    const prefix =
      section.crumbs.length > 0 ? `${section.crumbs.join(" > ")}\n\n` : "";
    const budget = Math.max(1, maxTokens - estimate(prefix));
    if (estimate(slice(span)) <= budget) {
      push(span, section.crumbs);
      continue;
    }
    // Oversized: greedy-pack whole blocks (paragraphs / fenced code) up to
    // the budget; a block alone over budget degrades to line packing.
    const flushInto: Span[] = [];
    let acc: Span | null = null;
    const flush = () => {
      if (acc) flushInto.push(acc);
      acc = null;
    };
    const fits = (candidate: Span) => estimate(slice(candidate)) <= budget;
    for (const block of splitBlocks(lines, span)) {
      const merged: Span | null = acc
        ? { start: acc.start, end: block.end }
        : null;
      if (merged && fits(merged)) {
        acc = merged;
        continue;
      }
      flush();
      if (fits(block)) {
        acc = block;
        continue;
      }
      // Line packing: never split inside a line — a single over-budget line
      // still becomes its own chunk.
      let lineAcc: Span | null = null;
      for (let i = block.start; i <= block.end; i++) {
        const grown: Span = lineAcc
          ? { start: lineAcc.start, end: i }
          : { start: i, end: i };
        if (lineAcc && !fits(grown)) {
          flushInto.push(lineAcc);
          lineAcc = { start: i, end: i };
        } else {
          lineAcc = grown;
        }
      }
      if (lineAcc) flushInto.push(lineAcc);
    }
    flush();
    for (const piece of flushInto) {
      const trimmed = trimSpan(lines, piece);
      if (trimmed) push(trimmed, section.crumbs);
    }
  }

  return chunks;
}
