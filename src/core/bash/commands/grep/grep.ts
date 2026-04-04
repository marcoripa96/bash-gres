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
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const prefix = showPrefix ? `${filePath}:` : "";
            const numPrefix = lineNumbers ? `${i + 1}:` : "";
            allMatches.push(`${prefix}${numPrefix}${lines[i]}`);
          }
        }
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
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const numPrefix = lineNumbers ? `${i + 1}:` : "";
        results.push(`${path}:${numPrefix}${lines[i]}`);
      }
    }
    return;
  }
  const entries = await ctx.fs.readdirWithTypes(path);
  for (const entry of entries) {
    const fullPath =
      path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    if (entry.isDirectory) {
      await grepRecursive(ctx, fullPath, regex, lineNumbers, results);
    } else if (entry.isFile) {
      const content = await ctx.fs.readFile(fullPath);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const numPrefix = lineNumbers ? `${i + 1}:` : "";
          results.push(`${fullPath}:${numPrefix}${lines[i]}`);
        }
      }
    }
  }
}
