import yargsParser from "yargs-parser";
import type { Command, CommandContext } from "../../types.js";
import { ok, err } from "../../types.js";

export const grepCommand: Command = {
  name: "grep",
  async execute(args, ctx, pipedInput) {
    const parsed = yargsParser(args, {
      boolean: ["r", "R", "i", "n"],
      configuration: {
        "short-option-groups": true,
        "halt-at-non-option": true,
      },
    });
    const recursive = !!(parsed.r || parsed.R);
    const ignoreCase = !!parsed.i;
    const lineNumbers = !!parsed.n;
    const positional = parsed._.map(String);

    if (positional.length === 0) return err("grep: missing pattern");

    const pattern = positional[0];
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");

    if (positional.length === 1 && pipedInput) {
      const lines = pipedInput.split("\n");
      const matches = lines
        .map((line, i) => ({ line, num: i + 1 }))
        .filter(({ line }) => regex.test(line))
        .map(({ line, num }) => (lineNumbers ? `${num}:${line}` : line));
      if (matches.length === 0)
        return { exitCode: 1, stdout: "", stderr: "" };
      return ok(matches.join("\n") + "\n");
    }

    const filePaths = positional.slice(1);
    const allMatches: string[] = [];
    const showPrefix = filePaths.length > 1 || recursive;

    for (const filePath of filePaths) {
      const resolved = ctx.resolve(filePath);
      if (recursive) {
        await grepRecursive(ctx, resolved, regex, lineNumbers, allMatches);
      } else {
        const content = await ctx.fs.readFile(resolved);
        pushMatches(content, regex, lineNumbers, showPrefix ? `${filePath}:` : "", allMatches);
      }
    }

    if (allMatches.length === 0)
      return { exitCode: 1, stdout: "", stderr: "" };
    return ok(allMatches.join("\n") + "\n");
  },
};

async function grepRecursive(
  ctx: CommandContext,
  path: string,
  regex: RegExp,
  lineNumbers: boolean,
  results: string[],
): Promise<void> {
  const info = await ctx.fs.stat(path);
  if (info.isFile) {
    const content = await ctx.fs.readFile(path);
    pushMatches(content, regex, lineNumbers, `${path}:`, results);
    return;
  }

  const resolvedRoot = await ctx.fs.realpath(path).catch(() => path);
  const entries = await ctx.fs.walk(path);
  for (const entry of entries) {
    if (!entry.isFile) {
      continue;
    }

    const entryPath =
      resolvedRoot === path
        ? entry.path
        : path + entry.path.slice(resolvedRoot.length);
    const content = await ctx.fs.readFile(entryPath);
    pushMatches(content, regex, lineNumbers, `${entryPath}:`, results);
  }
}

function pushMatches(
  content: string,
  regex: RegExp,
  lineNumbers: boolean,
  prefix: string,
  results: string[],
): void {
  let lineStart = 0;
  let lineNumber = 1;

  for (let i = 0; i <= content.length; i++) {
    if (i !== content.length && content[i] !== "\n") {
      continue;
    }

    const line = content.slice(lineStart, i);
    if (regex.test(line)) {
      const numPrefix = lineNumbers ? `${lineNumber}:` : "";
      results.push(`${prefix}${numPrefix}${line}`);
    }

    lineStart = i + 1;
    lineNumber++;
  }
}
