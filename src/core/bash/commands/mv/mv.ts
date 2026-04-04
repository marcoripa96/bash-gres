import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const mvCommand: Command = {
  name: "mv",
  async execute(args, ctx) {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length < 2) return err("mv: missing operand");

    if (paths.length > 2) {
      const destArg = paths[paths.length - 1];
      const destDir = ctx.resolve(destArg);

      try {
        const destStat = await ctx.fs.stat(destDir);
        if (!destStat.isDirectory) {
          return err(`mv: target '${destArg}': Not a directory`);
        }
      } catch {
        return err(`mv: target '${destArg}': No such file or directory`);
      }

      for (const sourceArg of paths.slice(0, -1)) {
        const src = ctx.resolve(sourceArg);
        const srcName = src.split("/").pop()!;
        const dest = destDir === "/" ? `/${srcName}` : `${destDir}/${srcName}`;
        await ctx.fs.mv(src, dest);
      }
      return ok("");
    }

    const src = ctx.resolve(paths[0]);
    let dest = ctx.resolve(paths[1]);

    // If dest is an existing directory, move INTO it
    try {
      const destStat = await ctx.fs.stat(dest);
      if (destStat.isDirectory) {
        const srcName = src.split("/").pop()!;
        dest = dest === "/" ? `/${srcName}` : `${dest}/${srcName}`;
      }
    } catch {
      // dest doesn't exist — mv will rename src to dest
    }

    await ctx.fs.mv(src, dest);
    return ok("");
  },
};
