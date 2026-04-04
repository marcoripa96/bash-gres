import yargsParser from "yargs-parser";
import type { Command, CommandContext } from "../../types.js";
import { ok } from "../../types.js";

const READ_CHUNK_SIZE = 4096;

export const headCommand: Command = {
  name: "head",
  async execute(args, ctx, pipedInput) {
    const parsed = yargsParser(args, {
      string: ["n"],
      configuration: { "short-option-groups": true },
    });
    const nStr = parsed.n !== undefined ? String(parsed.n) : "10";
    const n = parseInt(nStr, 10);
    const paths = parsed._.map(String);

    const sources =
      paths.length > 0
        ? await Promise.all(
            paths.map(async (path) => ({
              label: path === "-" ? "standard input" : path,
              text:
                path === "-"
                  ? selectHead(pipedInput, n)
                  : await readHead(ctx, ctx.resolve(path), n),
            })),
          )
        : [{ label: "standard input", text: selectHead(pipedInput, n) }];

    const sections = sources.map(({ label, text }) => {
      if (sources.length === 1) {
        return text;
      }
      return `==> ${label} <==\n${text}`;
    });

    return ok(sections.join(sources.length > 1 ? "\n" : ""));
  },
};

async function readHead(
  ctx: CommandContext,
  path: string,
  n: number,
): Promise<string> {
  if (n <= 0) {
    return n === 0 ? "" : selectHead(await ctx.fs.readFile(path), n);
  }

  let offset = 0;
  let buffer = "";
  while (true) {
    const chunk = await ctx.fs.readFile(path, {
      offset,
      limit: READ_CHUNK_SIZE,
    });
    if (chunk === "") {
      return buffer;
    }

    buffer += chunk;
    if (countNewlines(buffer) >= n) {
      return sliceFirstLines(buffer, n);
    }
    if (chunk.length < READ_CHUNK_SIZE) {
      return buffer;
    }
    offset += chunk.length;
  }
}

function selectHead(text: string, n: number): string {
  const lines = splitLines(text);
  if (n < 0) {
    return lines.slice(0, Math.max(0, lines.length + n)).join("");
  }
  return lines.slice(0, Math.max(0, n)).join("");
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

function sliceFirstLines(text: string, n: number): string {
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    newlines++;
    if (newlines === n) {
      return text.slice(0, i + 1);
    }
  }
  return text;
}
