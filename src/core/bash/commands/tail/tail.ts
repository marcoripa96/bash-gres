import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok } from "../../types.js";

export const tailCommand: Command = {
  name: "tail",
  async execute(args, ctx, pipedInput) {
    const parsed = yargsParser(args, {
      string: ["n"],
      configuration: { "short-option-groups": true },
    });
    const nStr = parsed.n !== undefined ? String(parsed.n) : "10";
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
    if (nStr.startsWith("+")) {
      // tail -n +N: starting from line N (1-based)
      const lineNum = parseInt(nStr.slice(1), 10);
      result = allLines.slice(Math.max(0, lineNum - 1));
    } else {
      const n = parseInt(nStr, 10);
      result = allLines.slice(-n);
    }
    return ok(result.join("\n") + (result.length ? "\n" : ""));
  },
};
