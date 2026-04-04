import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const cdCommand: Command = {
  name: "cd",
  async execute(args, ctx) {
    const target = args[0] || "/";
    const resolved = ctx.resolve(target);
    const stat = await ctx.fs.stat(resolved);
    if (!stat.isDirectory) {
      return err(`cd: ${target}: Not a directory`);
    }
    ctx.setCwd(resolved);
    return ok("");
  },
};
