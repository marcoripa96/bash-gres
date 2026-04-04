import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const mvCommand: Command = {
  name: "mv",
  async execute(args, ctx) {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length < 2) return err("mv: missing operand");

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
