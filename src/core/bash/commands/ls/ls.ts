import yargsParser from "yargs-parser";
import type { Command, CommandContext } from "../../types.js";
import { ok } from "../../types.js";
import { formatLong } from "../../helpers.js";

export const lsCommand: Command = {
  name: "ls",
  async execute(args, ctx) {
    const parsed = yargsParser(args, {
      boolean: ["l", "a"],
      configuration: { "short-option-groups": true },
    });
    const longFormat = !!parsed.l;
    const showAll = !!parsed.a;
    const paths = parsed._.map(String);

    const targets = paths.length > 0 ? paths : [ctx.cwd];

    // When multiple targets are given and some are files, list them individually
    if (targets.length > 1) {
      const allLines: string[] = [];
      for (const t of targets) {
        const resolved = ctx.resolve(t);
        const s = await ctx.fs.stat(resolved);
        if (s.isDirectory) {
          allLines.push(...(await lsDir(ctx, resolved, longFormat, showAll)));
        } else {
          const name = resolved.split("/").pop() || resolved;
          allLines.push(longFormat ? formatLong(name, s) : name);
        }
      }
      return ok(allLines.join("\n") + (allLines.length ? "\n" : ""));
    }

    const target = ctx.resolve(targets[0]);

    const stat = await ctx.fs.stat(target);
    if (!stat.isDirectory) {
      const name = target.split("/").pop() || target;
      if (longFormat) {
        return ok(formatLong(name, stat) + "\n");
      }
      return ok(name + "\n");
    }

    const lines = await lsDir(ctx, target, longFormat, showAll);
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
  },
};

async function lsDir(
  ctx: CommandContext,
  target: string,
  longFormat: boolean,
  showAll: boolean,
): Promise<string[]> {
  const entries = await ctx.fs.readdirWithTypes(target);
  const filtered = showAll
    ? entries
    : entries.filter((e) => !e.name.startsWith("."));

  if (!longFormat) {
    const names: string[] = [];
    if (showAll) names.push(".", "..");
    names.push(...filtered.map((e) => e.name));
    return names;
  }

  const lines: string[] = [];
  if (showAll) {
    const dirStat = await ctx.fs.stat(target);
    lines.push(formatLong(".", dirStat));
    const parentDir =
      target === "/"
        ? "/"
        : target.split("/").slice(0, -1).join("/") || "/";
    try {
      const parentStat = await ctx.fs.stat(parentDir);
      lines.push(formatLong("..", parentStat));
    } catch {
      lines.push(formatLong("..", dirStat));
    }
  }

  for (const entry of filtered) {
    const entryPath =
      target === "/" ? `/${entry.name}` : `${target}/${entry.name}`;
    const s = await ctx.fs.lstat(entryPath);
    lines.push(formatLong(entry.name, s));
  }
  return lines;
}
