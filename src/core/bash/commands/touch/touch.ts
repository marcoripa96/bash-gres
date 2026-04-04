import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const touchCommand: Command = {
  name: "touch",
  async execute(args, ctx) {
    if (args.length === 0) return err("touch: missing operand");
    for (const arg of args) {
      const path = ctx.resolve(arg);
      const exists = await ctx.fs.exists(path);
      if (exists) {
        await ctx.fs.utimes(path, new Date(), new Date());
      } else {
        await ctx.fs.writeFile(path, "");
      }
    }
    return ok("");
  },
};
