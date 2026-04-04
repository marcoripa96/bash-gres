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

    const text =
      paths.length > 0
        ? await ctx.fs.readFile(ctx.resolve(paths[0]))
        : pipedInput;

    const allLines = text.split("\n");
    // Remove trailing empty element from trailing newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    let result: string[];
    if (n < 0) {
      // head -n -N: all lines except the last N
      result = allLines.slice(0, Math.max(0, allLines.length + n));
    } else {
      result = allLines.slice(0, n);
    }
    return ok(result.join("\n") + (result.length ? "\n" : ""));
  },
};
