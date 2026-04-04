import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const mkdirCommand: Command = {
  name: "mkdir",
  async execute(args, ctx) {
    const parsed = yargsParser(args, {
      boolean: ["p"],
      configuration: { "short-option-groups": true },
    });
    const recursive = !!parsed.p;
    const paths = parsed._.map(String);

    if (paths.length === 0) return err("mkdir: missing operand");
    for (const p of paths) {
      await ctx.fs.mkdir(ctx.resolve(p), { recursive });
    }
    return ok("");
  },
};
