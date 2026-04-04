import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const readlinkCommand: Command = {
  name: "readlink",
  async execute(args, ctx) {
    if (args.length === 0) return err("readlink: missing operand");
    const target = await ctx.fs.readlink(ctx.resolve(args[0]));
    return ok(target + "\n");
  },
};
