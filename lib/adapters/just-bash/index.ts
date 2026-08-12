/**
 * just-bash adapter: `semgrep`, the semantic-grep command.
 *
 * `createSemgrepCommand({ fs })` returns a just-bash custom command the host
 * passes to `new Bash({ fs, customCommands: [...] })`, so an agent's shell
 * session gets chunk search without leaving bash:
 *
 *     semgrep [-k N] "query" [path]
 *
 * One hit per line, grep-style and addressable — the line range hydrates
 * with the session's own tooling (`sed -n 12,34p file`):
 *
 *     /content/pricing.md:12-34  [0.0323]  Pricing > Plans — Plans start at…
 *
 * Dispatch follows the handle: a `PgFileSystem` constructed with the `embed`
 * option searches hybrid (BM25 + vector, RRF-fused); without one it is
 * BM25-only — same query language, weaker recall, zero configuration. All
 * imports from just-bash are type-only, so the optional peer dependency
 * stays optional.
 */
import type { Command, CommandContext, ExecResult } from "just-bash";
import type { PgFileSystem } from "../../core/filesystem.js";
import type { ChunkSearchResult } from "../../core/types.js";

export interface CreateSemgrepCommandOptions {
  /**
   * The searchable filesystem — normally the same `PgFileSystem` instance
   * the `Bash` session runs on, so results honor the handle's version,
   * excludes and mounts.
   */
  fs: PgFileSystem;
}

/** Hits per query unless `-k N` says otherwise. */
const DEFAULT_K = 5;

/** Keep one hit to one terminal line: snippet budget after the location. */
const SNIPPET_MAX = 100;

const USAGE = 'usage: semgrep [-k N] "query" [path]';

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/** grep's exit contract: 1 = no match, 2 = error. */
function fail(exitCode: 1 | 2, stderr = ""): ExecResult {
  return { stdout: "", stderr, exitCode };
}

/**
 * The first prose line of a chunk, for the one-line preview. `content` is
 * the breadcrumb prefix + the section body, and the body opens with its own
 * markdown heading — both already shown via `headingPath`, so the preview
 * skips them and starts at the text.
 */
function snippet(hit: ChunkSearchResult): string {
  let body = hit.content;
  if (hit.headingPath && body.startsWith(hit.headingPath)) {
    body = body.slice(hit.headingPath.length);
  }
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return "";
  return line.length > SNIPPET_MAX ? line.slice(0, SNIPPET_MAX - 1) + "…" : line;
}

function formatHit(hit: ChunkSearchResult): string {
  const location = `${hit.path}:${hit.startLine}-${hit.endLine}`;
  const rank = `[${hit.rank.toFixed(4)}]`;
  const text = snippet(hit);
  const preview = hit.headingPath
    ? text
      ? `${hit.headingPath} — ${text}`
      : hit.headingPath
    : text;
  return `${location}  ${rank}  ${preview}`;
}

interface ParsedArgs {
  k: number;
  query: string;
  path?: string;
}

/** `[-k N] query [path]`, with `--` ending flag parsing grep-style. */
function parseArgs(args: string[]): ParsedArgs | { error: string } {
  let k = DEFAULT_K;
  const positional: string[] = [];
  let flagsDone = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!flagsDone && arg === "--") {
      flagsDone = true;
    } else if (!flagsDone && (arg === "-k" || /^-k\d/.test(arg))) {
      const raw = arg === "-k" ? args[++i] : arg.slice(2);
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < 1) {
        return { error: `semgrep: -k expects a positive integer\n${USAGE}` };
      }
      k = n;
    } else if (!flagsDone && arg.startsWith("-") && arg !== "-") {
      return { error: `semgrep: unknown option ${arg}\n${USAGE}` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) return { error: `semgrep: missing query\n${USAGE}` };
  if (positional.length > 2) {
    return { error: `semgrep: too many arguments\n${USAGE}` };
  }
  return { k, query: positional[0]!, path: positional[1] };
}

/**
 * Build the `semgrep` command over a searchable `PgFileSystem`. Register it
 * on the session: `new Bash({ fs, customCommands: [createSemgrepCommand({ fs })] })`.
 */
export function createSemgrepCommand(
  options: CreateSemgrepCommandOptions,
): Command {
  const { fs } = options;
  return {
    name: "semgrep",
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      const parsed = parseArgs(args);
      if ("error" in parsed) return fail(2, parsed.error + "\n");

      const path = parsed.path
        ? fs.resolvePath(ctx.cwd, parsed.path)
        : undefined;

      let hits: ChunkSearchResult[];
      try {
        hits = fs.hasEmbedder
          ? await fs.hybridSearch(parsed.query, { path, limit: parsed.k })
          : await fs.textSearch(parsed.query, { path, limit: parsed.k });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return fail(2, `semgrep: ${message}\n`);
      }

      if (hits.length === 0) return fail(1);
      return ok(hits.map(formatHit).join("\n") + "\n");
    },
  };
}
