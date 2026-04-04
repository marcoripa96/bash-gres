import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok } from "../../types.js";

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
              text: path === "-" ? pipedInput : await ctx.fs.readFile(ctx.resolve(path)),
            })),
          )
        : [{ label: "standard input", text: pipedInput }];

    const sections = sources.map(({ label, text }) => {
      const result = selectHead(text, n);
      if (sources.length === 1) {
        return result;
      }
      return `==> ${label} <==\n${result}`;
    });

    return ok(sections.join(sources.length > 1 ? "\n" : ""));
  },
};

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
