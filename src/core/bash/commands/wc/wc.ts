import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok } from "../../types.js";

export const wcCommand: Command = {
  name: "wc",
  async execute(args, ctx, pipedInput) {
    const parsed = yargsParser(args, {
      boolean: ["l", "w", "c"],
      configuration: { "short-option-groups": true },
    });
    let countLines = !!parsed.l;
    let countWords = !!parsed.w;
    let countChars = !!parsed.c;
    const paths = parsed._.map(String);

    if (!countLines && !countWords && !countChars) {
      countLines = countWords = countChars = true;
    }

    const formatWcLine = (text: string, name: string): string => {
      const lines =
        text.length === 0
          ? 0
          : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const words = text.split(/\s+/).filter(Boolean).length;
      const chars = new TextEncoder().encode(text).byteLength;

      const parts: string[] = [];
      if (countLines) parts.push(String(lines));
      if (countWords) parts.push(String(words));
      if (countChars) parts.push(String(chars));
      return parts.join("\t") + (name ? `\t${name}` : "");
    };

    if (paths.length === 0) {
      return ok(formatWcLine(pipedInput, "") + "\n");
    }

    const outputLines: string[] = [];
    for (const p of paths) {
      const text = await ctx.fs.readFile(ctx.resolve(p));
      outputLines.push(formatWcLine(text, p));
    }

    if (paths.length > 1) {
      // Add total line
      let totalText = "";
      for (const p of paths) {
        totalText += await ctx.fs.readFile(ctx.resolve(p));
      }
      outputLines.push(formatWcLine(totalText, "total"));
    }

    return ok(outputLines.join("\n") + "\n");
  },
};
