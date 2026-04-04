import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const cpCommand: Command = {
  name: "cp",
  async execute(args, ctx) {
    const parsed = yargsParser(args, {
      boolean: ["r", "R"],
      configuration: { "short-option-groups": true },
    });
    const recursive = !!(parsed.r || parsed.R);
    const paths = parsed._.map(String);

    if (paths.length < 2) return err("cp: missing operand");

    if (paths.length > 2) {
      const destArg = paths[paths.length - 1];
      const destDir = ctx.resolve(destArg);

      try {
        const destStat = await ctx.fs.stat(destDir);
        if (!destStat.isDirectory) {
          return err(`cp: target '${destArg}': Not a directory`);
        }
      } catch {
        return err(`cp: target '${destArg}': No such file or directory`);
      }

      for (const sourceArg of paths.slice(0, -1)) {
        const src = ctx.resolve(sourceArg);
        const srcName = src.split("/").pop()!;
        const dest = destDir === "/" ? `/${srcName}` : `${destDir}/${srcName}`;
        await ctx.fs.cp(src, dest, { recursive });
      }
      return ok("");
    }

    const src = ctx.resolve(paths[0]);
    let dest = ctx.resolve(paths[1]);

    // If dest is an existing directory, copy INTO it
    try {
      const destStat = await ctx.fs.stat(dest);
      if (destStat.isDirectory) {
        const srcName = src.split("/").pop()!;
        dest = dest === "/" ? `/${srcName}` : `${dest}/${srcName}`;
      }
    } catch {
      // dest doesn't exist, that's fine — cp creates it
    }

    await ctx.fs.cp(src, dest, { recursive });
    return ok("");
  },
};
