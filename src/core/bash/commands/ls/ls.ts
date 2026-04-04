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
    const targets = parsed._.map(String);
    const requested = targets.length > 0 ? targets : [ctx.cwd];
    const multipleTargets = requested.length > 1;

    const sections: string[] = [];
    for (const targetArg of requested) {
      sections.push(
        await renderTarget(ctx, targetArg, {
          longFormat,
          showAll,
          multipleTargets,
        }),
      );
    }

    return ok(sections.join(multipleTargets ? "\n\n" : "") + "\n");
  },
};

async function renderTarget(
  ctx: CommandContext,
  targetArg: string,
  options: {
    longFormat: boolean;
    showAll: boolean;
    multipleTargets: boolean;
  },
): Promise<string> {
  const resolved = ctx.resolve(targetArg);
  const lstat = await ctx.fs.lstat(resolved);
  const stat = lstat.isSymbolicLink ? await ctx.fs.stat(resolved) : lstat;

  const listDirectory = options.longFormat ? lstat.isDirectory : stat.isDirectory;
  if (!listDirectory) {
    return await formatSingleEntry(ctx, targetArg, resolved, lstat, options.longFormat);
  }

  const lines = await lsDir(ctx, resolved, options.longFormat, options.showAll);
  if (!options.multipleTargets) {
    return lines.join("\n");
  }

  return lines.length > 0 ? `${targetArg}:\n${lines.join("\n")}` : `${targetArg}:`;
}

async function formatSingleEntry(
  ctx: CommandContext,
  displayName: string,
  resolved: string,
  lstat: {
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  },
  longFormat: boolean,
): Promise<string> {
  if (!longFormat) {
    return displayName;
  }

  if (lstat.isSymbolicLink) {
    const target = await ctx.fs.readlink(resolved);
    return formatLong(`${displayName} -> ${target}`, lstat);
  }

  return formatLong(displayName, lstat);
}

async function lsDir(
  ctx: CommandContext,
  target: string,
  longFormat: boolean,
  showAll: boolean,
): Promise<string[]> {
  if (!longFormat) {
    const entries = await ctx.fs.readdirWithTypes(target);
    const filtered = showAll
      ? entries
      : entries.filter((entry) => !entry.name.startsWith("."));
    const names: string[] = [];
    if (showAll) names.push(".", "..");
    names.push(...filtered.map((entry) => entry.name));
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
    const parentStat = await ctx.fs.stat(parentDir);
    lines.push(formatLong("..", parentStat));
  }

  const detailedEntries = await ctx.fs.readdirWithStats(target);
  const visibleEntries = showAll
    ? detailedEntries
    : detailedEntries.filter((entry) => !entry.name.startsWith("."));

  for (const entry of visibleEntries) {
    const displayName = entry.isSymbolicLink && entry.symlinkTarget !== null
      ? `${entry.name} -> ${entry.symlinkTarget}`
      : entry.name;
    lines.push(formatLong(displayName, entry));
  }

  return lines;
}
