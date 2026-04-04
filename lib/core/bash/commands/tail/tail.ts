import yargsParser from "yargs-parser";
import type { Command, CommandContext } from "../../types.js";
import { ok } from "../../types.js";

const READ_CHUNK_SIZE = 4096;

export const tailCommand: Command = {
  name: "tail",
  async execute(args, ctx, pipedInput) {
    const parsed = yargsParser(args, {
      string: ["n"],
      configuration: { "short-option-groups": true },
    });
    const nStr = parsed.n !== undefined ? String(parsed.n) : "10";
    const paths = parsed._.map(String);

    const sources =
      paths.length > 0
        ? await Promise.all(
            paths.map(async (path) => ({
              label: path === "-" ? "standard input" : path,
              text:
                path === "-"
                  ? selectTail(pipedInput, nStr)
                  : await readTail(ctx, ctx.resolve(path), nStr),
            })),
          )
        : [{ label: "standard input", text: selectTail(pipedInput, nStr) }];

    const sections = sources.map(({ label, text }) => {
      if (sources.length === 1) {
        return text;
      }
      return `==> ${label} <==\n${text}`;
    });

    return ok(sections.join(sources.length > 1 ? "\n" : ""));
  },
};

async function readTail(
  ctx: CommandContext,
  path: string,
  nStr: string,
): Promise<string> {
  if (nStr.startsWith("+")) {
    return selectTail(await ctx.fs.readFile(path), nStr);
  }

  const n = parseInt(nStr, 10);
  if (n <= 0) {
    return "";
  }

  const stat = await ctx.fs.stat(path);
  let end = stat.size;
  let buffer = "";

  while (true) {
    const chunkSize = Math.min(READ_CHUNK_SIZE, end);
    const start = Math.max(0, end - chunkSize);
    const chunk = await ctx.fs.readFile(path, {
      offset: start,
      limit: end - start,
    });
    buffer = chunk + buffer;

    const newlineCount = countNewlines(buffer);
    const hasBoundary = buffer.endsWith("\n")
      ? newlineCount > n
      : newlineCount >= n;
    if (start === 0 || hasBoundary) {
      return selectTail(buffer, nStr);
    }

    end = start;
  }
}

function selectTail(text: string, nStr: string): string {
  const lines = splitLines(text);
  if (nStr.startsWith("+")) {
    const lineNum = parseInt(nStr.slice(1), 10);
    return lines.slice(Math.max(0, lineNum - 1)).join("");
  }

  const n = parseInt(nStr, 10);
  if (n <= 0) {
    return "";
  }
  return lines.slice(-n).join("");
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}
