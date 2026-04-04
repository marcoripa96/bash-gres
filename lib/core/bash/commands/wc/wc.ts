import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok } from "../../types.js";

const WHITESPACE_RE = /\s/;

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

    const formatWcLine = (counts: WcCounts, name: string): string => {
      const parts: string[] = [];
      if (countLines) parts.push(String(counts.lines));
      if (countWords) parts.push(String(counts.words));
      if (countChars) parts.push(String(counts.chars));
      return parts.join("\t") + (name ? `\t${name}` : "");
    };

    if (paths.length === 0) {
      return ok(formatWcLine(countText(pipedInput), "") + "\n");
    }

    const outputLines: string[] = [];
    const totalCounts: WcCounts = { lines: 0, words: 0, chars: 0 };
    for (const p of paths) {
      const text = await ctx.fs.readFile(ctx.resolve(p));
      const counts = countText(text);
      totalCounts.lines += counts.lines;
      totalCounts.words += counts.words;
      totalCounts.chars += counts.chars;
      outputLines.push(formatWcLine(counts, p));
    }

    if (paths.length > 1) {
      outputLines.push(formatWcLine(totalCounts, "total"));
    }

    return ok(outputLines.join("\n") + "\n");
  },
};

interface WcCounts {
  lines: number;
  words: number;
  chars: number;
}

function countText(text: string): WcCounts {
  let newlineCount = 0;
  let words = 0;
  let inWord = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") newlineCount++;

    const isWhitespace = WHITESPACE_RE.test(char);
    if (isWhitespace) {
      inWord = false;
      continue;
    }

    if (!inWord) {
      words++;
      inWord = true;
    }
  }

  return {
    lines: text.length === 0 ? 0 : newlineCount + (text.endsWith("\n") ? 0 : 1),
    words,
    chars: new TextEncoder().encode(text).byteLength,
  };
}
