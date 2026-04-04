import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const lnCommand: Command = {
  name: "ln",
  async execute(args, ctx) {
    const parsed = yargsParser(args, {
      boolean: ["s"],
      configuration: { "short-option-groups": true },
    });
    const symbolic = !!parsed.s;
    const paths = parsed._.map(String);

    if (paths.length < 2) return err("ln: missing operand");
    if (symbolic) {
      await ctx.fs.symlink(paths[0], ctx.resolve(paths[1]));
    } else {
      await ctx.fs.link(ctx.resolve(paths[0]), ctx.resolve(paths[1]));
    }
    return ok("");
  },
};
